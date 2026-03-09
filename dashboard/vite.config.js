export default {
  server: {
    proxy: {
      '/api': 'http://localhost:5199',
      '/events': 'http://localhost:5199',
      '/playbacks': 'http://localhost:5199',
    }
  }
}
