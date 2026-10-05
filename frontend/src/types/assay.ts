/**
 * 离子组分分析（Assay）
 * 化验室按取样批次出具化验单：记录 Li⁺ / K⁺ / Mg²⁺ / Na⁺ 浓度并给出达标判定。
 * 复检更新结论后原化验单作废（不删除，两次结论都留存），新单轮次 +1。
 */

/** 达标判定：未达标 / 接近 / 达标 */
export type AssayVerdict = '未达标' | '接近' | '达标'

export const ASSAY_VERDICT_OPTIONS: AssayVerdict[] = ['未达标', '接近', '达标']

/** 化验单状态：有效 / 作废（复检后旧单作废，结论保留备查） */
export type AssayStatus = '有效' | '作废'

export const ASSAY_STATUS_OPTIONS: AssayStatus[] = ['有效', '作废']

export interface Assay {
  id: string
  /** 所属蒸发池 */
  pondId: string
  /** 取样批次号（与走水编排对账的对账键之一，空串表示升级遗留未登记） */
  sampleBatch: string
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
  /** 单据状态：复检更新结论后原单作废，两次结论都保留 */
  status: AssayStatus
  /** 该取样批次的化验轮次：1 = 初检，2 起为复检 */
  round: number
  /** 复检来源化验单 id（初检为 null），形成复检链 */
  retestOf: string | null
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑离子组分分析的表单草稿 */
export interface AssayDraft {
  pondId: string
  sampleBatch: string
  date: string
  liGpl: number
  kGpl: number
  mgGpl: number
  naGpl: number
  labName: string
  verdict: AssayVerdict
  verdictManual: boolean
}
