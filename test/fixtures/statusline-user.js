// Stands in for a user's own statusLine command: reads the same snapshot on
// stdin that Claude would have given it, prints one line from it.
let body = '';
process.stdin.on('data', (c) => { body += c; });
process.stdin.on('end', () => {
  let model = '?';
  try { model = JSON.parse(body).model.display_name; } catch (_) {}
  process.stdout.write(`USER-LINE ${model}`);
});
