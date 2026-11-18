// Bun emits the real HTTP request event but omits the Node diagnostic notification.
// Forward the original request/response so the fixture observes their actual end and close.
import { channel } from 'node:diagnostics_channel';
import { Server } from 'node:http';

const start = channel('http.server.request.start');
const emit = Server.prototype.emit;
Server.prototype.emit = function (event, ...args) {
  if (event === 'request' && start.hasSubscribers) {
    const [request, response] = args;
    start.publish({ request, response, server: this });
  }
  return emit.call(this, event, ...args);
};
