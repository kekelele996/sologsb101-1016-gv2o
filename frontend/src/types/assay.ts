/**
 * 离子组分分析（Assay）
 * 记录 Li⁺ / K⁺ / Mg²⁺ / Na⁺ 浓度并给出达标判定，达标的池自动进入出卤候选。
 */

/** 达标判定：未达标 / 接近 / 达标 */
export type AssayVerdict = '未达标' | '接近' | '达标'

export const ASSAY_VERDICT_OPTIONS: AssayVerdict[] = ['未达标', '接近', '达标']

/** 化验单状态：有效 / 作废（复检后原单作废，两次结论都保留） */
export type AssayStatus = '有效' | '作废'

export const ASSAY_STATUS_OPTIONS: AssayStatus[] = ['有效', '作废']

export interface Assay {
  id: string
  /** 所属蒸发池 */
  pondId: string
  /** 取样批次号：化验室与调度端对账的依据（池号 + 批次） */
  batchNo: string
  /** 取样日期 YYYY-MM-DD */
  date: string
  /** Li⁺（g/L） */
  liGpl: number
  /** K⁺（g/L） */
  kGpl: number
  /** Mg²⁺（g/L） */
  mgGpl: number
  /** Na⁺（g/L） */
  naGpl: number
  /** 化验室 */
  labName: string
  /** 达标判定（默认自动判定，可人工覆盖） */
  verdict: AssayVerdict
  /** 判定是否被人工覆盖 */
  verdictManual: boolean
  /** 化验单状态：有效 / 作废 */
  status: AssayStatus
  /** 作废原因（如：复检） */
  voidReason?: string
  /** 复检新单 → 指向原化验单 id */
  retestOf?: string
  /** 原化验单 → 指向复检新单 id */
  retestBy?: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑离子组分分析的表单草稿 */
export interface AssayDraft {
  pondId: string
  batchNo: string
  date: string
  liGpl: number
  kGpl: number
  mgGpl: number
  naGpl: number
  labName: string
  verdict: AssayVerdict
  verdictManual: boolean
}
