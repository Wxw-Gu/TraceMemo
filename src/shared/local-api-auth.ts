export interface ApiTokenStatus {
  available: boolean
  hasToken: boolean
  maskedToken: string
  error?: string
}

export interface ApiTokenRevealResult extends ApiTokenStatus {
  token?: string
}

export interface ApiTokenActionResult extends ApiTokenStatus {
  success: boolean
}
