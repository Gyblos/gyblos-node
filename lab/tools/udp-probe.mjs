import { NAT } from '@gyblos/lab-p2p/constants';

export const UDP_PROBE_SOURCE = `
const socket = require('node:dgram').createSocket('udp4');
const [own, port, remote, remotePort, duration, interval] = process.argv.slice(1);
let received = 0;
socket.on('message', (bytes, peer) => {
  if (bytes.toString() === 'synthetic-nonce' && peer.address === remote && peer.port === Number(remotePort)) received++;
});
socket.on('error', () => { process.exitCode = 1; socket.close(); });
socket.bind(Number(port), own, () => {
  const sender = setInterval(() => socket.send(Buffer.from('synthetic-nonce'), Number(remotePort), remote), Number(interval));
  setTimeout(() => { clearInterval(sender); socket.close(() => console.log(JSON.stringify({received}))); }, Number(duration));
});
`;

export const UDP_PROBE_ARGUMENTS = [
  String(NAT.probe.durationMs),
  String(NAT.probe.intervalMs),
];
