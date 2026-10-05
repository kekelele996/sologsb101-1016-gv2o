/**
 * 取样批次与对账工具
 * - 批次号生成（按池号 + 取样日期）
 * - 调度端与化验室按「池号 + 取样批次」对账
 * - 复检作废：原化验单作废，引用该批次的走水编排退回待排（在 db.ts 事务内完成）
 */
import type { Assay } from '../types/assay';
import type { Schedule } from '../types/schedule';
import { effectiveVerdict } from './brine';

/** 对账状态：对账通过 / 对账不通过 / 未对账 */
export type ReconcileStatus = '对账通过' | '对账不通过' | '未对账';

export interface ReconcileResult {
  status: ReconcileStatus;
  /** 对账所依据的有效化验单（对账通过时有值） */
  assay: Assay | null;
  /** 说明文案（未对账 / 对账不通过的原因） */
  reason: string;
}

/**
 * 生成取样批次号：按池号 + 取样日期，同池同日的化验单共用一个批次。
 * 旧数据升级回填时也用同一规则（按池号回填）。
 */
export function suggestBatchNo(pondCode: string, date: string): string {
  return `${pondCode}-${date}`;
}

/** 取有效化验单（作废的不参与对账） */
export function validAssays(assays: Assay[]): Assay[] {
  return assays.filter((row) => row.status !== '作废');
}

/** 某口池的有效取样批次号（按化验日期倒序、去重），供编排单选择批次 */
export function batchesOfPond(assays: Assay[], pondId: string): string[] {
  const set = new Set<string>();
  validAssays(assays)
    .filter((row) => row.pondId === pondId && row.batchNo.trim() !== '')
    .sort((a, b) => b.date.localeCompare(a.date))
    .forEach((row) => set.add(row.batchNo));
  return Array.from(set);
}

/**
 * 调度端对账：排走水时按「池号 + 取样批次」与化验室对账，
 * 化验室对同一批次判了达标才对账通过。
 */
export function reconcileSchedule(
  schedule: Pick<Schedule, 'pondId' | 'batchNo'>,
  assays: Assay[],
): ReconcileResult {
  const batch = (schedule.batchNo ?? '').trim();
  if (batch === '') {
    return { status: '未对账', assay: null, reason: '走水编排未登记取样批次，无法与化验室对账' };
  }
  const candidates = validAssays(assays)
    .filter((row) => row.pondId === schedule.pondId && row.batchNo === batch)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (candidates.length === 0) {
    return {
      status: '对账不通过',
      assay: null,
      reason: `批次 ${batch} 没有有效的化验单（可能已作废或未化验）`,
    };
  }
  const passed = candidates.filter((row) => effectiveVerdict(row) === '达标');
  if (passed.length > 0) {
    return { status: '对账通过', assay: passed[passed.length - 1], reason: '' };
  }
  const latest = candidates[candidates.length - 1];
  return {
    status: '对账不通过',
    assay: latest,
    reason: `批次 ${batch} 的化验结论为「${effectiveVerdict(latest)}」，未达标不能走水`,
  };
}

/** 取某口池最近一次有效化验结论（作废的不算） */
export function latestValidAssay(assays: Assay[], pondId: string): Assay | null {
  const list = validAssays(assays)
    .filter((row) => row.pondId === pondId)
    .sort((a, b) => a.date.localeCompare(b.date));
  return list.length > 0 ? list[list.length - 1] : null;
}
