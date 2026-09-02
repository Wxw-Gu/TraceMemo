const truthyValues = new Set(['1', 'true', 'yes', 'on'])

export const isTruthyDebugFlag = (value: unknown): boolean =>
  truthyValues.has(
    String(value ?? '')
      .trim()
      .toLowerCase()
  )
