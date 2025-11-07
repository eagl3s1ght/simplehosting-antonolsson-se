export default function errorReporterPlugin() {
  return {
    name: 'error-reporter',
    configureServer(server) {
      server.ws.on('custom:error', (data, client) => {
        const { type, message, file, line, column, stack } = data;
        const loc = file && line ? `${file}:${line}:${column || ''}` : '';
        console.error(
          `\n[VITE DEV] ${type.toUpperCase()}\n`,
          message,
          loc ? `\n   at ${loc}` : '',
          stack ? `\n   Stack:\n${stack}` : ''
        );
      });
    }
  };
}