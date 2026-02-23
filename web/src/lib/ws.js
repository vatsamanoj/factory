export function openTaskSocket({ onEvent }) {
  const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/ws`);

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onEvent?.(data);
    } catch (err) {
      console.error('Invalid WS message', err);
    }
  };

  return socket;
}
