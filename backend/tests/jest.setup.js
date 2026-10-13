// Testovaci setup: vypne realna volani Ollamy, aby testy byly DETERMINISTICKE
// a rychle bez ohledu na to, zda na stroji bezi Ollama. Testy jsou psane pro
// stav "AI nedostupna" (rychly lexikalni/fallback). Lokalni jest.mock v konkretnim
// testu tento globalni mock prebije.
jest.mock('ollama', () => {
  const fail = () => Promise.reject(new Error('AI vypnuta v testech (jest.setup.js)'));
  const client = {
    chat: fail, generate: fail, embeddings: fail, embed: fail,
    show: fail, pull: fail, create: fail, delete: fail, copy: fail,
    list: () => Promise.resolve({ models: [] }),
    ps: () => Promise.resolve({ models: [] }),
  };
  return { __esModule: true, default: client, Ollama: function () { return client; } };
});

// Supertest spouští app.listen(0) na všech rozhraních (::) a pak se připojí na
// 127.0.0.1:port. Na macOS může takový port na 127.0.0.1 už držet jiný proces
// (např. lokální proxy) — požadavek skončí u něj a test dostane cizí 400
// (nález 13. 10. 2026). Ephemerní server proto vážeme přímo na 127.0.0.1 a
// požadavek odešleme až po 'listening' (vazba na konkrétní adresu je asynchronní).
{
  const https = require('https');
  const Test = require('supertest/lib/test');
  if (!Test.prototype.__lexisLoopback) {
    Test.prototype.__lexisLoopback = true;
    const origAddr = Test.prototype.serverAddress;
    const origEnd = Test.prototype.end;
    Test.prototype.serverAddress = function (app, path) {
      if (app.address()) return origAddr.call(this, app, path);
      this._server = app.listen({ port: 0, host: '127.0.0.1' });
      this.__lexisPath = path;
      this.__lexisProto = app instanceof https.Server ? 'https' : 'http';
      return this.__lexisProto + '://127.0.0.1:0' + path; // skutečný port doplní end()
    };
    Test.prototype.end = function (fn) {
      const s = this._server;
      if (this.__lexisPath === undefined || !s) return origEnd.call(this, fn);
      const go = () => {
        this.url = this.__lexisProto + '://127.0.0.1:' + s.address().port + this.__lexisPath;
        return origEnd.call(this, fn);
      };
      if (s.listening) return go();
      s.once('listening', go);
      s.once('error', (e) => { if (typeof fn === 'function') fn(e); });
      return this;
    };
  }
}
