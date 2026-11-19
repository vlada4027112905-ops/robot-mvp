// Адаптер: эмулятор вызывает сервис по HTTP так же, как арена.
export class HttpStrategy {
  constructor(baseUrl, token) {
    this.base = baseUrl.replace(/\/$/, '');
    this.token = token;
  }
  async _post(path, body, seq) {
    const headers = { 'content-type': 'application/json', 'x-arena-mode': this.mode || 'practice', 'x-arena-spec': 'v1' };
    if (seq !== undefined) headers['x-arena-seq'] = String(seq);
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(this.base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  async start(msg) {
    this.runId = msg.runId;
    this.mode = msg.mode;
    this.seq = 0;
    return this._post(`/v1/runs/${encodeURIComponent(this.runId)}/start`, msg);
  }
  async event(req) {
    this.seq = req.seq + 1;
    return this._post(`/v1/runs/${encodeURIComponent(this.runId)}/event`, req, req.seq);
  }
  async finish(msg) {
    return this._post(`/v1/runs/${encodeURIComponent(this.runId)}/finish`, msg, this.seq);
  }
}
