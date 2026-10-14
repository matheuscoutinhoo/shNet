import { WebSocket } from 'ws';
import { once } from 'node:events';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers';
const { AbortSignal, fetch } = globalThis;
process.once('message', async ({ actors, topology }) => {
  const sockets = [],
    latencies = {};
  try {
    for (const actor of actors) {
      actor.notifications = 0;
      actor.unexpectedNotifications = 0;
      const socket = new WebSocket(actor.notificationBase.replace(/^http/, 'ws') + '/api/events', {
        headers: actor.headers,
      });
      socket.on('message', (message) => {
        const event = JSON.parse(String(message));
        if (event.type === 'project.updated') {
          if (event.id === actor.project) actor.notifications++;
          else actor.unexpectedNotifications++;
        }
      });
      sockets.push(socket);
      await once(socket, 'open', { signal: AbortSignal.timeout(30000) });
    }
    const request = async (actor, route, method = 'GET', body, expected = 200) => {
      const started = performance.now();
      const response = await fetch(actor.base + route, {
        method,
        headers: actor.headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      const data = await response.text();
      const label =
        method +
        ' ' +
        route.replace(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/g, ':id') +
        ' [' +
        expected +
        ']';
      (latencies[label] ??= []).push(performance.now() - started);
      if (response.status !== expected)
        throw new Error(`Resposta inesperada: ${method} (${response.status}, esperado ${expected}).`);
      return data ? JSON.parse(data) : undefined;
    };
    for (let round = 0; round < 3; round++) {
      process.send({ kind: 'round-start', round });
      await once(process, 'message');
      const at = performance.now();
      const completed = await Promise.allSettled(
        actors.map(async (actor) => {
          const result = await request(actor, '/api/projects/' + actor.project, 'PUT', {
            name: 'Capacity saved ' + round,
            revision: actor.revision,
            topology,
          });
          if (
            result.revision !== actor.revision + 1 ||
            result.topology.devices.length !== topology.devices.length
          )
            throw new Error('Save perdeu revisão ou equipamentos.');
          actor.revision = result.revision;
          const reopened = await request(actor, '/api/projects/' + actor.project);
          if (
            reopened.revision !== actor.revision ||
            reopened.topology.devices.length !== topology.devices.length
          )
            throw new Error('Reabertura divergiu do save.');
          await request(actor, '/api/projects');
        })
      );
      const failure = completed.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
      process.send({ kind: 'round-end', round, wallMs: performance.now() - at });
    }
    await request(
      actors[0],
      '/api/projects/' + actors[0].project,
      'PUT',
      { name: 'Stale', revision: 1, topology },
      409
    );
    await request(actors[1], '/api/projects/' + actors[0].project, 'GET', undefined, 404);
    const until = Date.now() + 10000;
    while (actors.some((a) => a.notifications < 3) && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (actors.some((a) => a.notifications < 3 || a.unexpectedNotifications))
      throw new Error('Notificações incompletas ou cruzaram proprietários.');
    const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
    process.send({
      kind: 'complete',
      routes: Object.fromEntries(
        Object.entries(latencies).map(([route, values]) => [
          route,
          {
            count: values.length,
            p50Ms: percentile(values, 0.5),
            p95Ms: percentile(values, 0.95),
            maxMs: Math.max(...values),
          },
        ])
      ),
    });
  } catch (error) {
    process.send({ kind: 'error', message: error instanceof Error ? error.message : 'Cliente falhou.' });
  } finally {
    for (const socket of sockets) socket.terminate();
    process.disconnect();
  }
});
