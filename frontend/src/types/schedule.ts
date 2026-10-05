/**
 * 走水编排（Schedule）
 * 调度端按日期排序的走水与出卤计划，可通过拖拽调整先后顺序。
 * 排走水时按「池号 + 取样批次」与化验室对账：同批次化验判定达标才允许推进走水。
 */

/** 走水状态：待排 / 已排 / 走水中 / 已出卤 */
export type ScheduleState = '待排' | '已排' | '走水中' | '已出卤'

export const SCHEDULE_STATE_OPTIONS: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 状态推进顺序 */
export const SCHEDULE_STATE_FLOW: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

export interface Schedule {
  id: string
  /** 所属蒸发池 */
  pondId: string
  /** 对账取样批次号（空串表示升级遗留未登记，需调度端补登后才能推进） */
  sampleBatch: string
  /** 计划走水日期 YYYY-MM-DD */
  planDate: string
  /** 目标密度（g/cm³） */
  targetDensity: number
  /** 计划量（m³） */
  volumeM3: number
  /** 调度员 */
  operator: string
  /** 走水状态 */
  state: ScheduleState
  /** 手工拖拽后的排序序号，越小越先走水 */
  orderIndex: number
  /** 退回待排原因（化验复检作废联动退回时写入；空串表示非退回件，重新推进后清空） */
  returnNote: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑走水编排的表单草稿 */
export interface ScheduleDraft {
  pondId: string
  sampleBatch: string
  planDate: string
  targetDensity: number
  volumeM3: number
  operator: string
  state: ScheduleState
  orderIndex: number
}
