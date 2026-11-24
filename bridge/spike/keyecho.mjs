// Prints the bytes each read from stdin delivers, in hex, so a test can see
// exactly what terminal.sendText typed. Ctrl-D (0x04) twice exits.
process.stdin.setRawMode?.(true);
process.stdin.resume();
console.log('KEYECHO READY');
let eot = 0;
process.stdin.on('data', (buf) => {
  console.log('BYTES ' + [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' '));
  eot = buf.includes(4) ? eot + 1 : 0;
  if (eot >= 2) process.exit(0);
});
