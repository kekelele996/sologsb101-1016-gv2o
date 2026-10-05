/**
 * /schedules 走水与出卤编排（调度端）
 * 按日期排序、拖拽调整走水先后顺序、逐条推进状态；出卤完成回写池阶段与实际密度。
 * 排走水按「池号 + 取样批次」与化验室对账：同批次有效化验单判定达标才允许推进；
 * 化验复检作废旧单后，用过该批次的编排退回待排，由调度端本侧重排。
 * 消费模型：Schedule、Gate、Assay；复用组件：<FilterBar>、<EmptyPanel>、<StatBadge>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import StageTag from '../components/common/StageTag';
import { usePondStore } from '../stores/pondStore';
import { useScheduleStore } from '../stores/scheduleStore';
import { SCHEDULE_STATE_OPTIONS, type Schedule, type ScheduleDraft, type ScheduleState } from '../types/schedule';
import { reconcileBatch } from '../utils/brine';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

const STATE_STYLE: Record<ScheduleState, string> = {
  待排: 'border-slate-300 bg-slate-100 text-slate-600',
  已排: 'border-sky-300 bg-sky-50 text-sky-700',
  走水中: 'border-amber-300 bg-amber-50 text-amber-700',
  已出卤: 'border-emerald-300 bg-emerald-50 text-emerald-700',
};

function emptyDraft(pondId: string, sampleBatch: string, orderIndex: number): ScheduleDraft {
  return {
    pondId,
    sampleBatch,
    planDate: today(),
    targetDensity: 1.15,
    volumeM3: 800,
    operator: '',
    state: '待排',
    orderIndex,
  };
}

export default function ScheduleBoard() {
  const pondStore = usePondStore();
  const scheduleStore = useScheduleStore();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal<Schedule | null>(null);
  const [dragOverId, setDragOverId] = createSignal<string | null>(null);
  const [draft, setDraft] = createStore<ScheduleDraft>(emptyDraft('', '', 1));

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  /** 对账：池号 + 取样批次 → 化验室同批次有效化验单判定 */
  const reconcileOf = (row: Schedule) => reconcileBatch(row.pondId, row.sampleBatch, pondStore.state.assays);

  /** 该池已出具过的取样批次（对话框 datalist 建议项） */
  const batchOptions = createMemo<string[]>(() => {
    const set = new Set(
      pondStore.state.assays
        .filter((row) => row.pondId === draft.pondId && row.sampleBatch.trim() !== '')
        .map((row) => row.sampleBatch),
    );
    return Array.from(set).sort();
  });

  /** 该池最新有效化验批次（新建编排时的默认对账批次） */
  const latestActiveBatch = (pondId: string): string => {
    const active = pondStore.state.assays
      .filter((row) => row.pondId === pondId && row.status === '有效' && row.sampleBatch.trim() !== '')
      .sort((a, b) => a.date.localeCompare(b.date) || a.round - b.round);
    return active.length === 0 ? '' : active[active.length - 1].sampleBatch;
  };

  const ordered = createMemo<Schedule[]>(() =>
    [...scheduleStore.state.rows].sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate)),
  );

  const filtered = createMemo<Schedule[]>(() => {
    const current = scheduleStore.filters();
    const series = pondStore.state.currentSeries;
    const keyword = current.keyword.trim().toLowerCase();
    return ordered().filter((row) => {
      const pond = pondOf(row.pondId);
      if (series !== null && pond?.seriesName !== series) return false;
      if (current.state !== 'all' && row.state !== current.state) return false;
      if (keyword === '') return true;
      return (
        pondLabel(row.pondId).toLowerCase().includes(keyword) ||
        row.operator.toLowerCase().includes(keyword) ||
        row.sampleBatch.toLowerCase().includes(keyword) ||
        row.planDate.includes(keyword)
      );
    });
  });

  const stats = createMemo(() => {
    const list = ordered();
    const active = list.filter((row) => row.state !== '已出卤');
    return {
      total: list.length,
      pending: list.filter((row) => row.state === '待排').length,
      running: list.filter((row) => row.state === '走水中').length,
      done: list.filter((row) => row.state === '已出卤').length,
      reconciled: active.filter((row) => reconcileOf(row).ok).length,
      returned: list.filter((row) => row.returnNote !== '').length,
      volume: Math.round(list.reduce((acc, row) => acc + row.volumeM3, 0) * 10) / 10,
      donePct: list.length === 0 ? 0 : Math.round((list.filter((row) => row.state === '已出卤').length / list.length) * 1000) / 10,
    };
  });

  const openCreate = (): void => {
    const pondId = pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? pondStore.state.ponds[0]?.id ?? '';
    setEditingId(null);
    setDraft(emptyDraft(pondId, latestActiveBatch(pondId), ordered().length + 1));
    setDialogOpen(true);
  };

  const openEdit = (row: Schedule): void => {
    setEditingId(row.id);
    setDraft({
      pondId: row.pondId,
      sampleBatch: row.sampleBatch,
      planDate: row.planDate,
      targetDensity: row.targetDensity,
      volumeM3: row.volumeM3,
      operator: row.operator,
      state: row.state,
      orderIndex: row.orderIndex,
    });
    setDialogOpen(true);
  };

  const submit = async (): Promise<void> => {
    if (draft.pondId === '') {
      scheduleStore.setMessage('请选择蒸发池');
      return;
    }
    if (editingId() === null) {
      const row = await scheduleStore.createSchedule({ ...draft });
      scheduleStore.setMessage(
        row.sampleBatch === ''
          ? `已新建走水计划：${row.planDate}；尚未登记取样批次，对账通过前不能推进走水`
          : `已新建走水计划：${row.planDate}，对账批次 ${row.sampleBatch}`,
      );
    } else {
      await scheduleStore.updateSchedule(editingId() as string, { ...draft });
    }
    setDialogOpen(false);
  };

  const confirmDelete = async (): Promise<void> => {
    const row = deleting();
    if (row === null) return;
    await scheduleStore.deleteSchedule(row.id);
    setDeleting(null);
  };

  const handleDrop = async (targetId: string): Promise<void> => {
    const fromId = scheduleStore.draggingId();
    setDragOverId(null);
    scheduleStore.setDraggingId(null);
    if (fromId === null || fromId === targetId) return;
    await scheduleStore.moveBefore(fromId, targetId);
  };

  const nextStateLabel = (state: ScheduleState): string => {
    if (state === '待排') return '标记已排';
    if (state === '已排') return '开始走水';
    if (state === '走水中') return '完成出卤';
    return '已出卤';
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="走水计划" value={stats().total} suffix="条" tone="primary" />
        <StatBadge label="待排" value={stats().pending} suffix="条" tone="default" />
        <StatBadge label="走水中" value={stats().running} suffix="条" tone="warning" />
        <StatBadge label="已出卤" value={stats().done} suffix="条" tone="success" />
        <StatBadge
          label="对账通过"
          value={stats().reconciled}
          suffix="条"
          tone="info"
          hint="未完成的编排中，池号 + 取样批次对账达标、可推进走水的条数"
        />
        <StatBadge
          label="退回重排"
          value={stats().returned}
          suffix="条"
          tone={stats().returned > 0 ? 'danger' : 'default'}
          hint="化验复检作废旧单后联动退回待排的编排，由调度端本侧重排"
        />
        <StatBadge label="计划总量" value={stats().volume} suffix="m³" tone="info" />
        <StatBadge label="出卤完成率" value={`${stats().donePct}%`} percent={stats().donePct} tone="success" />
      </div>

      <Show when={scheduleStore.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {scheduleStore.state.lastMessage}
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">走水与出卤编排</h2>
          <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={pondStore.state.ponds.length === 0}>
            + 新建走水计划
          </button>
        </header>

        <FilterBar
          keyword={scheduleStore.filters().keyword}
          onKeyword={(value) => scheduleStore.patchFilters({ keyword: value })}
          fields={[
            { key: 'series', label: '池系', options: pondStore.seriesOptions() },
            { key: 'state', label: '状态', options: [...SCHEDULE_STATE_OPTIONS] },
          ]}
          values={{ series: pondStore.state.currentSeries ?? 'all', state: scheduleStore.filters().state }}
          onChange={(key, value) => {
            if (key === 'series') pondStore.setCurrentSeries(value === 'all' ? null : value);
            if (key === 'state') scheduleStore.patchFilters({ state: value as ScheduleState | 'all' });
          }}
          onReset={() => {
            scheduleStore.resetFilters();
            pondStore.setCurrentSeries(pondStore.seriesOptions()[0] ?? null);
          }}
          resultText={`命中 ${filtered().length} / ${ordered().length} 条`}
        />

        <Show when={ordered().length === 0}>
          <EmptyPanel
            title="还没有走水编排"
            description="为蒸发池编排走水日期、目标密度与计划量，并登记取样批次与化验室对账；拖拽列表可以调整走水先后顺序，逐条推进到「已出卤」会自动回写池阶段。"
            actionText="新建第一条走水计划"
            onAction={openCreate}
          />
        </Show>

        <Show when={ordered().length > 0}>
          <ul class="space-y-2">
            <For each={filtered()}>
              {(row, index) => {
                const check = () => reconcileOf(row);
                return (
                  <li
                    draggable={true}
                    class={`rounded-lg border bg-white px-3.5 py-3 transition ${
                      dragOverId() === row.id ? 'border-brine-500 ring-1 ring-brine-400' : 'border-slate-200'
                    }`}
                    onDragStart={() => scheduleStore.setDraggingId(row.id)}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragOverId(row.id);
                    }}
                    onDragLeave={() => setDragOverId(null)}
                    onDrop={(event) => {
                      event.preventDefault();
                      void handleDrop(row.id);
                    }}
                  >
                    <div class="flex flex-wrap items-center gap-3">
                      <span class="grid h-7 w-7 shrink-0 cursor-grab place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-500">
                        {index() + 1}
                      </span>
                      <span class="cursor-grab text-slate-300" title="按住拖拽调整顺序">
                        ⠿
                      </span>
                      <div class="min-w-[180px] flex-1">
                        <p class="text-sm font-medium text-slate-800">{pondLabel(row.pondId)}</p>
                        <p class="text-xs text-slate-500">
                          计划日期 {row.planDate} · 调度员 {row.operator === '' ? '未填写' : row.operator}
                        </p>
                      </div>
                      <div class="flex items-center gap-2">
                        <StageTag stage={pondOf(row.pondId)?.stage ?? null} size="sm" />
                      </div>
                      <div class="text-xs text-slate-600">
                        <p>
                          目标密度 <span class="tabular-nums font-medium text-slate-800">{row.targetDensity}</span> g/cm³
                        </p>
                        <p>
                          当前密度{' '}
                          <span class="tabular-nums font-medium text-brine-700">
                            {pondStore.statOf(row.pondId).currentDensity || '—'}
                          </span>
                        </p>
                      </div>
                      <div class="text-xs text-slate-600">
                        <p>
                          计划量 <span class="tabular-nums font-medium text-slate-800">{row.volumeM3}</span> m³
                        </p>
                        <p>
                          取样批次{' '}
                          <span class="font-medium text-slate-800">{row.sampleBatch === '' ? '未登记' : row.sampleBatch}</span>
                        </p>
                      </div>
                      <span
                        class={`rounded border px-2 py-0.5 text-[11px] ${
                          check().ok
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                            : 'border-rose-300 bg-rose-50 text-rose-600'
                        }`}
                        title={check().reason}
                      >
                        {check().ok ? '对账达标' : '对账未过'}
                      </span>
                      <span class={`rounded border px-2 py-0.5 text-[11px] ${STATE_STYLE[row.state]}`}>{row.state}</span>
                      <div class="flex flex-wrap items-center gap-2">
                        <button
                          class="rounded-md border border-brine-300 bg-brine-50 px-2.5 py-1 text-xs text-brine-700 transition hover:bg-brine-100 disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={row.state === '已出卤' || !check().ok}
                          title={check().ok ? '' : check().reason}
                          onClick={async () => {
                            const next = await scheduleStore.advance(row.id);
                            if (next === null && row.state === '已出卤') scheduleStore.setMessage('该计划已处于「已出卤」状态');
                          }}
                        >
                          {nextStateLabel(row.state)}
                        </button>
                        <button class="text-xs text-brine-700 hover:underline" onClick={() => openEdit(row)}>
                          编辑
                        </button>
                        <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeleting(row)}>
                          删除
                        </button>
                      </div>
                    </div>
                    <Show when={row.returnNote !== ''}>
                      <p class="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs leading-relaxed text-amber-800">
                        已退回待排：{row.returnNote}。请调度端本侧确认复检结论后重新推进。
                      </p>
                    </Show>
                    <Show when={row.returnNote === '' && !check().ok && row.state !== '已出卤'}>
                      <p class="mt-2 text-xs leading-relaxed text-slate-400">{check().reason}</p>
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>

        <Show when={ordered().length > 0 && filtered().length === 0}>
          <EmptyPanel
            title="没有符合筛选条件的走水计划"
            description="可以切换池系或状态筛选条件，或直接重置筛选。"
            actionText="重置筛选"
            onAction={() => scheduleStore.resetFilters()}
          />
        </Show>
      </section>

      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '新建走水计划' : '编辑走水计划'}
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submit()}>
              保存
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>蒸发池</span>
            <select
              class={INPUT}
              value={draft.pondId}
              onChange={(event) => {
                const pondId = event.currentTarget.value;
                setDraft('pondId', pondId);
                if (editingId() === null) setDraft('sampleBatch', latestActiveBatch(pondId));
              }}
            >
              <option value="">请选择</option>
              <For each={pondStore.state.ponds}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName} · {pond.stage}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>取样批次（对账键）</span>
            <input
              class={INPUT}
              value={draft.sampleBatch}
              placeholder="如：北-03-0924"
              list="schedule-batch-options"
              onInput={(event) => setDraft('sampleBatch', event.currentTarget.value)}
            />
            <datalist id="schedule-batch-options">
              <For each={batchOptions()}>{(batch) => <option value={batch} />}</For>
            </datalist>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计划走水日期</span>
            <input type="date" class={INPUT} value={draft.planDate} onInput={(event) => setDraft('planDate', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>目标密度（g/cm³）</span>
            <input
              type="number"
              step="0.001"
              class={INPUT}
              value={draft.targetDensity}
              onInput={(event) => setDraft('targetDensity', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计划量（m³）</span>
            <input
              type="number"
              step="10"
              class={INPUT}
              value={draft.volumeM3}
              onInput={(event) => setDraft('volumeM3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>调度员</span>
            <input class={INPUT} value={draft.operator} onInput={(event) => setDraft('operator', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>走水状态</span>
            <select class={INPUT} value={draft.state} onChange={(event) => setDraft('state', event.currentTarget.value as ScheduleState)}>
              <For each={SCHEDULE_STATE_OPTIONS}>{(state) => <option value={state}>{state}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>排序序号（越小越先走水）</span>
            <input
              type="number"
              min="1"
              step="1"
              class={INPUT}
              value={draft.orderIndex}
              onInput={(event) => setDraft('orderIndex', Number(event.currentTarget.value))}
            />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          排走水按「池号 + 取样批次」与化验室对账：同批次有效化验单判定达标才能推进走水；
          化验复检作废旧单后，用过该批次的编排会退回待排，由调度端本侧重排。
          状态推进到「已出卤」时，会把该池推进到下一蒸发阶段，并把最新一次观测的密度回写为当前实际密度。
        </p>
      </AppDialog>

      <AppDialog
        open={deleting() !== null}
        title="确认删除走水计划？"
        width="max-w-lg"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeleting(null)}>
              取消
            </button>
            <button class={BTN_DANGER} onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除「{pondLabel(deleting()?.pondId ?? '')}」在 {deleting()?.planDate} 的走水计划
          {deleting()?.sampleBatch ? `（对账批次 ${deleting()?.sampleBatch}）` : ''}。
        </p>
      </AppDialog>
    </div>
  );
}
