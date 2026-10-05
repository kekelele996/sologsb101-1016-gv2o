/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * - v3：化验单新增取样批次 batchNo 与状态（有效/作废），走水编排新增对账批次 batchNo；
 *        旧数据按池号回填批次，对不上的单列升级报告；复检作废原单并退回引用批次的编排
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay, AssayVerdict } from '../types/assay';
import type { Schedule, ScheduleState } from '../types/schedule';
import { autoVerdict, estimateEvapMm } from './brine';
import { reconcileSchedule, suggestBatchNo } from './reconcile';
import { nowIso } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbbrinepond';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

/** v3 升级回填报告的 localStorage 键（对不上的记录单列在这里） */
const MIGRATION_REPORT_KEY = 'gbbrinepond:migrationReport';

/** 一条对不上的旧数据（升级时单列） */
export interface MigrationUnmatched {
  table: 'assays' | 'schedules';
  id: string;
  pondId: string;
  date: string;
  reason: string;
}

/** v3 升级回填报告 */
export interface MigrationReport {
  version: number;
  upgradedAt: string;
  /** 按池号回填批次号的化验条数 */
  assaysBackfilled: number;
  /** 按池号回填批次号的走水编排条数 */
  schedulesBackfilled: number;
  /** 对不上、无法回填的记录（单列） */
  unmatched: MigrationUnmatched[];
}

/** 读取 v3 升级回填报告（未发生过升级时为 null） */
export function getMigrationReport(): MigrationReport | null {
  try {
    const raw = window.localStorage.getItem(MIGRATION_REPORT_KEY);
    if (raw === null || raw === '') return null;
    return JSON.parse(raw) as MigrationReport;
  } catch {
    return null;
  }
}

/** 清除升级回填报告（用户已知悉后关闭提示） */
export function dismissMigrationReport(): void {
  try {
    window.localStorage.removeItem(MIGRATION_REPORT_KEY);
  } catch {
    /* 隐私模式下静默降级 */
  }
}

function saveMigrationReport(report: MigrationReport): void {
  try {
    window.localStorage.setItem(MIGRATION_REPORT_KEY, JSON.stringify(report));
  } catch {
    /* 隐私模式下写入失败时静默降级 */
  }
}

class BrinePondDatabase extends Dexie {
  ponds!: Table<Pond, string>;
  gates!: Table<Gate, string>;
  observations!: Table<Observation, string>;
  assays!: Table<Assay, string>;
  schedules!: Table<Schedule, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：建立全部表与 pondId+date 复合索引 ----------
    this.version(1).stores({
      ponds: 'id, code, seriesName, stage, status, createdAt',
      gates: 'id, fromPondId, toPondId, state',
      observations: 'id, pondId, date, [pondId+date], densityGcm3',
      assays: 'id, pondId, date, [pondId+date], verdict',
      schedules: 'id, pondId, planDate, state, orderIndex',
    });

    // ---------- v2：新增 evapMm 字段，并为旧记录补齐默认值 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('ponds'),
          tx.table('gates'),
          tx.table('observations'),
          tx.table('assays'),
          tx.table('schedules'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：卤水观测新增 evapMm，旧记录按密度/温度/水位/风力经验公式补齐
        await tx.table('observations').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.evapMm === 'number' && Number.isFinite(row.evapMm)) return;
          row.evapMm = estimateEvapMm(
            typeof row.densityGcm3 === 'number' ? row.densityGcm3 : 1.02,
            typeof row.tempC === 'number' ? row.tempC : 25,
            typeof row.levelCm === 'number' ? row.levelCm : 40,
            typeof row.windLevel === 'number' ? row.windLevel : 2,
          );
        });
        // 迁移 3：化验记录补齐人工覆盖标记
        await tx.table('assays').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.verdictManual !== 'boolean') row.verdictManual = false;
        });
        // 迁移 4：走水编排补齐排序序号（按计划日期兜底生成）
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.orderIndex !== 'number') {
            const date = typeof row.planDate === 'string' ? row.planDate : '2026-01-01';
            row.orderIndex = Number(date.replace(/-/g, '')) || 1;
          }
        });
      });

    // ---------- v3：化验单新增取样批次与状态，走水编排新增对账批次 ----------
    this.version(3)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual, batchNo, status',
        schedules: 'id, pondId, planDate, state, orderIndex, batchNo',
      })
      .upgrade(async (tx) => {
        const report: MigrationReport = {
          version: 3,
          upgradedAt: nowIso(),
          assaysBackfilled: 0,
          schedulesBackfilled: 0,
          unmatched: [],
        };

        const ponds = await tx.table('ponds').toArray();
        const pondById = new Map<string, Pond>(ponds.map((pond) => [pond.id, pond as Pond]));

        // 迁移 5：化验单按池号回填取样批次；旧数据没有作废概念，状态一律补「有效」
        const assayRows = (await tx.table('assays').toArray()) as Array<Record<string, unknown>>;
        for (const row of assayRows) {
          if (row.status !== '有效' && row.status !== '作废') row.status = '有效';
          if (typeof row.verdictManual !== 'boolean') row.verdictManual = false;
          row.revision = ROW_REVISION;
          if (typeof row.batchNo !== 'string' || row.batchNo.trim() === '') {
            const pond = pondById.get(String(row.pondId));
            if (pond === undefined) {
              // 对不上：池号不存在，无法按池号回填批次，单列
              report.unmatched.push({
                table: 'assays',
                id: String(row.id),
                pondId: String(row.pondId),
                date: String(row.date ?? ''),
                reason: '池号对不上：化验记录登记的蒸发池不存在，无法按池号回填取样批次',
              });
              continue;
            }
            row.batchNo = suggestBatchNo(pond.code, String(row.date ?? ''));
            report.assaysBackfilled += 1;
          }
        }
        await tx.table('assays').bulkPut(assayRows);

        // 迁移 6：走水编排按池号回填对账批次（取该池最近一次有效化验的批次）
        const scheduleRows = (await tx.table('schedules').toArray()) as Array<Record<string, unknown>>;
        for (const row of scheduleRows) {
          row.revision = ROW_REVISION;
          if (typeof row.batchNo !== 'string' || row.batchNo.trim() === '') {
            const pond = pondById.get(String(row.pondId));
            if (pond === undefined) {
              report.unmatched.push({
                table: 'schedules',
                id: String(row.id),
                pondId: String(row.pondId),
                date: String(row.planDate ?? ''),
                reason: '池号对不上：走水编排登记的蒸发池不存在，无法回填对账批次',
              });
              continue;
            }
            const pondAssays = assayRows
              .filter((item) => item.pondId === row.pondId && item.status === '有效' && typeof item.batchNo === 'string' && item.batchNo !== '')
              .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
            if (pondAssays.length === 0) {
              report.unmatched.push({
                table: 'schedules',
                id: String(row.id),
                pondId: String(row.pondId),
                date: String(row.planDate ?? ''),
                reason: '该池没有可对账的有效化验单，无法回填取样批次',
              });
              continue;
            }
            row.batchNo = String(pondAssays[pondAssays.length - 1].batchNo);
            report.schedulesBackfilled += 1;
          }
        }
        await tx.table('schedules').bulkPut(scheduleRows);

        // 对不上的记录单列报告，供 /export 页面展示
        saveMigrationReport(report);
      });
  }
}

export const db = new BrinePondDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.ponds.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 蒸发池 -------------------------------- */

export async function listPonds(): Promise<Pond[]> {
  const rows = await db.ponds.toArray();
  return rows.sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'zh-Hans-CN') || a.code.localeCompare(b.code));
}

export async function putPond(row: Pond): Promise<void> {
  await db.ponds.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 删除蒸发池，并级联清理相关闸门、观测、化验与走水计划 */
export async function removePond(id: string): Promise<void> {
  await db.transaction('rw', db.ponds, db.gates, db.observations, db.assays, db.schedules, async () => {
    const gates = await db.gates.toArray();
    const related = gates.filter((gate) => gate.fromPondId === id || gate.toPondId === id).map((gate) => gate.id);
    if (related.length > 0) await db.gates.bulkDelete(related);
    await db.observations.where('pondId').equals(id).delete();
    await db.assays.where('pondId').equals(id).delete();
    await db.schedules.where('pondId').equals(id).delete();
    await db.ponds.delete(id);
  });
}

/* -------------------------------- 闸门 -------------------------------- */

export async function listGates(): Promise<Gate[]> {
  return db.gates.toArray();
}

export async function putGate(row: Gate): Promise<void> {
  await db.gates.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 就地调整开度：同步推导闸门状态 */
export async function updateGateOpening(id: string, openingPct: number, state: Gate['state']): Promise<void> {
  await db.gates.update(id, { openingPct, state, updatedAt: nowIso() });
}

export async function removeGate(id: string): Promise<void> {
  await db.gates.delete(id);
}

/* ------------------------------ 卤水日观测 ------------------------------ */

export async function listObservations(): Promise<Observation[]> {
  const rows = await db.observations.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listObservationsByPond(pondId: string): Promise<Observation[]> {
  const rows = await db.observations.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 写入卤水日观测：同池同日仅保留一条（存在即覆盖原记录）。
 * evapMm 若未显式给出，则按经验公式自动估算。
 */
export async function upsertObservation(row: Observation): Promise<Observation> {
  const evapMm =
    Number.isFinite(row.evapMm) && row.evapMm > 0
      ? row.evapMm
      : estimateEvapMm(row.densityGcm3, row.tempC, row.levelCm, row.windLevel);
  const existing = await db.observations.where('[pondId+date]').equals([row.pondId, row.date]).first();
  const next: Observation = {
    ...row,
    id: existing === undefined ? row.id : existing.id,
    evapMm,
    createdAt: existing === undefined ? row.createdAt : existing.createdAt,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.observations.put(next);
  return next;
}

export async function removeObservation(id: string): Promise<void> {
  await db.observations.delete(id);
}

/* ------------------------------ 离子组分分析 ------------------------------ */

export async function listAssays(): Promise<Assay[]> {
  const rows = await db.assays.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listAssaysByPond(pondId: string): Promise<Assay[]> {
  const rows = await db.assays.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putAssay(row: Assay): Promise<void> {
  await db.assays.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeAssay(id: string): Promise<void> {
  await db.assays.delete(id);
}

/** 复检新单录入入参 */
export interface RetestInput {
  date: string;
  liGpl: number;
  kGpl: number;
  mgGpl: number;
  naGpl: number;
  labName: string;
  verdict: AssayVerdict;
  verdictManual: boolean;
}

/**
 * 复检作废：录入复检新单（同一取样批次），原化验单标记作废（两次结论都保留），
 * 并把引用该批次、已排 / 走水中的走水编排退回待排，由调度端本侧重排。
 * 返回新单 id 与被退回的编排列表。
 */
export async function voidAssayForRetest(
  originalId: string,
  retest: RetestInput,
): Promise<{ newId: string; returnedSchedules: Schedule[] }> {
  return db.transaction('rw', db.assays, db.schedules, async () => {
    const original = await db.assays.get(originalId);
    if (original === undefined) throw new Error('原化验单不存在');
    if (original.status === '作废') throw new Error('该化验单已作废，不能重复复检');

    const stamp = nowIso();
    const newId = `assay-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const newAssay: Assay = {
      id: newId,
      pondId: original.pondId,
      batchNo: original.batchNo,
      date: retest.date,
      liGpl: retest.liGpl,
      kGpl: retest.kGpl,
      mgGpl: retest.mgGpl,
      naGpl: retest.naGpl,
      labName: retest.labName,
      verdict: retest.verdictManual ? retest.verdict : autoVerdict(retest.liGpl, retest.kGpl),
      verdictManual: retest.verdictManual,
      status: '有效',
      retestOf: originalId,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await db.assays.put(newAssay);
    await db.assays.update(originalId, {
      status: '作废',
      voidReason: '复检',
      retestBy: newId,
      updatedAt: stamp,
      revision: ROW_REVISION,
    });

    // 退回引用该批次的已排 / 走水中编排
    const affected = await db.schedules
      .filter(
        (row) =>
          row.pondId === original.pondId &&
          row.batchNo === original.batchNo &&
          (row.state === '已排' || row.state === '走水中'),
      )
      .toArray();
    const returnedSchedules: Schedule[] = [];
    for (const row of affected) {
      const reason = `复检作废：批次 ${original.batchNo} 原化验单（${original.date}）已作废，以复检新单 ${newId} 为准重新对账排期`;
      await db.schedules.update(row.id, { state: '待排', returnedReason: reason, updatedAt: stamp, revision: ROW_REVISION });
      returnedSchedules.push({ ...row, state: '待排', returnedReason: reason });
    }
    return { newId, returnedSchedules };
  });
}

/* ------------------------------ 走水编排 ------------------------------ */

export async function listSchedules(): Promise<Schedule[]> {
  const rows = await db.schedules.toArray();
  return rows.sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate));
}

export async function putSchedule(row: Schedule): Promise<void> {
  await db.schedules.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSchedule(id: string): Promise<void> {
  await db.schedules.delete(id);
}

/** 按给定 id 顺序重写排序序号（拖拽排序后调用） */
export async function reorderSchedules(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.schedules, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.schedules.update(orderedIds[index], { orderIndex: index + 1, updatedAt: nowIso() });
    }
  });
}

/**
 * 出卤完成回写：把蒸发池推进到下一阶段，并把最新一次观测的密度对齐到实际密度。
 */
export async function applyDischarge(scheduleId: string, actualDensity: number): Promise<void> {
  await db.transaction('rw', db.ponds, db.schedules, db.observations, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule) return;
    await db.schedules.update(scheduleId, { state: '已出卤', updatedAt: nowIso() });
    const pond = await db.ponds.get(schedule.pondId);
    if (!pond) return;
    const nextStage: Pond['stage'] = pond.stage === '钠盐' ? '钾盐' : pond.stage === '钾盐' ? '锂盐' : '锂盐';
    await db.ponds.update(pond.id, { stage: nextStage, updatedAt: nowIso() });
    const list = await db.observations.where('pondId').equals(pond.id).toArray();
    if (list.length === 0) return;
    const latest = list.reduce((acc, item) => (item.date > acc.date ? item : acc));
    const density = actualDensity > 0 ? actualDensity : latest.densityGcm3;
    await db.observations.update(latest.id, {
      densityGcm3: density,
      evapMm: estimateEvapMm(density, latest.tempC, latest.levelCm, latest.windLevel),
      updatedAt: nowIso(),
    });
  });
}

/** 推进走水状态 */
export async function advanceScheduleState(scheduleId: string, next: ScheduleState, actualDensity: number): Promise<void> {
  if (next === '已出卤') {
    await applyDischarge(scheduleId, actualDensity);
    return;
  }
  // 对账校验：待排→已排、已排→走水中 必须与化验室对账通过（池号 + 批次 + 达标结论）
  if (next === '已排' || next === '走水中') {
    const schedule = await db.schedules.get(scheduleId);
    if (schedule === undefined) return;
    const assays = await db.assays.toArray();
    const result = reconcileSchedule(schedule, assays);
    if (result.status !== '对账通过') {
      throw new Error(result.reason || '对账未通过，不能推进走水');
    }
  }
  await db.schedules.update(scheduleId, { state: next, updatedAt: nowIso() });
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  ponds: Pond[];
  gates: Gate[];
  observations: Observation[];
  assays: Assay[];
  schedules: Schedule[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules] = await Promise.all([
    db.ponds.toArray(),
    db.gates.toArray(),
    db.observations.toArray(),
    db.assays.toArray(),
    db.schedules.toArray(),
  ]);
  return { name: DB_NAME, schemaVersion: DB_SCHEMA_VERSION, exportedAt: nowIso(), ponds, gates, observations, assays, schedules };
}

export interface ImportResult {
  assaysBackfilled: number;
  schedulesBackfilled: number;
}

/** 导入存档时的归一化：v2 存档没有批次与状态字段，按 v3 迁移同规则补齐 */
function normalizeImportedRows(
  ponds: Pond[],
  assays: Assay[],
  schedules: Schedule[],
): { assays: Assay[]; schedules: Schedule[]; result: ImportResult } {
  const pondByCode = new Map(ponds.map((pond) => [pond.id, pond]));
  let assaysBackfilled = 0;
  let schedulesBackfilled = 0;
  const normalizedAssays = assays.map((row) => {
    const next: Assay = { ...row };
    if (next.status !== '有效' && next.status !== '作废') next.status = '有效';
    if (typeof next.verdictManual !== 'boolean') next.verdictManual = false;
    if (typeof next.batchNo !== 'string' || next.batchNo.trim() === '') {
      const pond = pondByCode.get(next.pondId);
      if (pond !== undefined) {
        next.batchNo = suggestBatchNo(pond.code, next.date);
        assaysBackfilled += 1;
      }
    }
    return next;
  });
  const normalizedSchedules = schedules.map((row) => {
    const next: Schedule = { ...row };
    if (typeof next.batchNo !== 'string' || next.batchNo.trim() === '') {
      const pond = pondByCode.get(next.pondId);
      if (pond !== undefined) {
        const pondAssays = normalizedAssays
          .filter((item) => item.pondId === next.pondId && item.status === '有效' && item.batchNo.trim() !== '')
          .sort((a, b) => a.date.localeCompare(b.date));
        if (pondAssays.length > 0) {
          next.batchNo = pondAssays[pondAssays.length - 1].batchNo;
          schedulesBackfilled += 1;
        }
      }
    }
    return next;
  });
  return {
    assays: normalizedAssays,
    schedules: normalizedSchedules,
    result: { assaysBackfilled, schedulesBackfilled },
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<ImportResult> {
  const { assays, schedules, result } = normalizeImportedRows(snapshot.ponds, snapshot.assays, snapshot.schedules);
  await db.transaction('rw', db.ponds, db.gates, db.observations, db.assays, db.schedules, async () => {
    await Promise.all([
      db.ponds.clear(),
      db.gates.clear(),
      db.observations.clear(),
      db.assays.clear(),
      db.schedules.clear(),
    ]);
    await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.gates.bulkPut(snapshot.gates.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.assays.bulkPut(assays.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.schedules.bulkPut(schedules.map((row) => ({ ...row, revision: ROW_REVISION })));
  });
  return result;
}

export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', db.ponds, db.gates, db.observations, db.assays, db.schedules, async () => {
    await Promise.all([
      db.ponds.clear(),
      db.gates.clear(),
      db.observations.clear(),
      db.assays.clear(),
      db.schedules.clear(),
    ]);
  });
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [ponds, gates, observations, assays, schedules] = await Promise.all([
    db.ponds.count(),
    db.gates.count(),
    db.observations.count(),
    db.assays.count(),
    db.schedules.count(),
  ]);
  return { ponds, gates, observations, assays, schedules };
}
