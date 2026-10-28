export function inspectJsonValue(original: unknown): { value: unknown; encoded: boolean } {
  let value = original
  
  for (let layer = 0; layer < 4 && typeof value === 'string'; layer++) {
    let text = value.trim()
    const fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text)
    if (fenced) text = fenced[1].trim()
    if (!['{', '[', '"'].includes(text[0])) break
    try {
      value = JSON.parse(text)
      if (value && typeof value === 'object') return { value, encoded: true }
    } catch { break }
  }
  return { value: original, encoded: false }
}

export type JsonTextPart = { kind: 'text'; text: string } | { kind: 'json'; text: string; value: unknown }

export function inspectJsonText(text: string): JsonTextPart[] {
  const parts: JsonTextPart[] = []
  let copied = 0, start = 0, blocks = 0
  while (start < text.length && blocks < 30) {
    if (text[start] !== '{' && text[start] !== '[') { start++; continue }
    const stack: string[] = []
    let quoted = false, escaped = false, end = start
    for (; end < text.length; end++) {
      const char = text[end]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === '{' || char === '[') stack.push(char)
      else if (char === '}' || char === ']') {
        if (stack.pop() !== (char === '}' ? '{' : '[')) break
        if (!stack.length) break
      }
    }
    if (end === text.length) break 
    const raw = text.slice(start, end + 1)
    const inspected = inspectJsonValue(raw)
    if (inspected.encoded) {
      if (start > copied) parts.push({ kind: 'text', text: text.slice(copied, start) })
      parts.push({ kind: 'json', text: raw, value: inspected.value })
      copied = end + 1
      blocks++
    }
    start = end + 1
  }
  if (copied < text.length) parts.push({ kind: 'text', text: text.slice(copied) })
  return parts
}
