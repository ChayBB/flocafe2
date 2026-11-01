/** Prints a standalone HTML page through the system print dialog from a hidden frame. */
export function printHtmlInFrame(html: string): void {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();
  const print = () => {
    win.onafterprint = () => frame.remove();
    win.focus();
    win.print();
  };
  if (doc.readyState === 'complete') print();
  else win.onload = print;
}
