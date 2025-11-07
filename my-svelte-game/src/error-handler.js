if (import.meta.env.DEV && import.meta.hot) {
  const send = (type, payload) => {
    import.meta.hot.send('custom:error', { type, ...payload });
  };

  window.addEventListener('error', (ev) => {
    const { message, filename, lineno, colno, error } = ev;
    send('js-error', {
      message,
      file: filename,
      line: lineno,
      column: colno,
      stack: error?.stack
    });
  });

  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason;
    send('promise-error', {
      message: reason?.message || String(reason),
      stack: reason?.stack
    });
  });
}