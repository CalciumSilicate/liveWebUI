/**
 * 复制文本到剪贴板。优先用异步 Clipboard API,不可用(非安全上下文等)时
 * 回退到临时 textarea + execCommand,尽量在各环境下都能复制成功。
 */
export async function copyText(value: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.top = '-1000px'
  document.body.append(textarea)
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)

  const ok = document.execCommand('copy')
  textarea.remove()
  if (!ok) {
    throw new Error('复制失败')
  }
}
