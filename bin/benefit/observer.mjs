import crypto from 'node:crypto';
// OTLP/HTTP JSON logs only. Never retain bodies, tool arguments, prompts or resources.
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const value = v => v?.stringValue ?? v?.intValue ?? v?.doubleValue ?? v?.boolValue;
const attrs = list => Object.fromEntries((list || []).map(a => [a.key, value(a.value)]));
const number = v => ['string','number'].includes(typeof v) && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const safeName = v => typeof v === 'string' && /^[a-zA-Z0-9_.:@/-]{1,160}$/.test(v) ? v : null;
export class Observer {
  constructor() { this.sessions = new Map(); this.seen = new Set(); this.received = 0; this.ignored = 0; this.limitReached = false; this.lastAcceptedAt = null; }
  accept(payload) {
    if (!Array.isArray(payload.resourceLogs)) throw new Error('Expected OTLP resourceLogs');
    for (const resource of payload.resourceLogs) for (const scope of resource.scopeLogs || []) for (const record of scope.logRecords || []) {
      const a = attrs(record.attributes);
      const event = String(a['event.name'] || record.eventName || value(record.body) || '').replace(/^claude_code\./, '');
      if (!['skill_activated', 'api_request', 'api_error'].includes(event)) { this.ignored++; continue; }
      if (!a['session.id']) { this.ignored++; continue; }
      const sessionId = digest(a['session.id']).slice(0,16);
      const stamp = record.timeUnixNano || a['event.timestamp'];
      const correlation = a.request_id || (stamp && `${stamp}:${a['event.sequence'] ?? ''}`);
      if (!correlation) { this.ignored++; continue; }
      const key = digest(`${sessionId}:${event}:${correlation}`);
      if (this.seen.has(key)) continue;
      if (this.limitReached || this.seen.size >= 50000 || (!this.sessions.has(sessionId) && this.sessions.size >= 200)) {
        this.limitReached = true;
        const error = new Error('Capture limit reached; restart for a new capture');
        error.code = 'CAPTURE_LIMIT';
        throw error;
      }
      this.seen.add(key); this.received++;
      this.lastAcceptedAt = new Date().toISOString();
      let s = this.sessions.get(sessionId);
      if (!s) { s = {id:sessionId, skills:Object.create(null), requests:0, errors:0, updated_at:null}; this.sessions.set(sessionId,s); }
      s.updated_at = new Date().toISOString();
      let name = safeName(a['skill.name']);
      if (!name || ['custom_skill','third-party','custom'].includes(name)) name = 'Unattributed / redacted';
      let skill = s.skills[name];
      if (!skill) skill = s.skills[name] = {name,activations:0,requests:0,errors:0,cost_usd:0,cost_samples:0,tokens:0,token_samples:0,request_ms:0,duration_samples:0};
      if (event === 'skill_activated') skill.activations++;
      if (event === 'api_error') { skill.errors++; s.errors++; }
      if (event === 'api_request') {
        skill.requests++; s.requests++;
        const cost = number(a.cost_usd) ?? (number(a.cost_usd_micros) === null ? null : Number(a.cost_usd_micros)/1e6);
        if (cost !== null) { skill.cost_usd += cost; skill.cost_samples++; }
        const tokens = ['input_tokens','output_tokens','cache_read_tokens','cache_creation_tokens'].map(k=>number(a[k]));
        if (tokens.every(v=>v!==null)) { skill.tokens += tokens.reduce((a,b)=>a+b,0); skill.token_samples++; }
        const ms = number(a.duration_ms); if (ms !== null) {skill.request_ms += ms; skill.duration_samples++;}
      }
    }
  }
  snapshot() { return {schema_version:1, source:'claude-code-otlp-logs', received:this.received, ignored:this.ignored, capture_status:this.limitReached?'stopped':this.received?'receiving':'waiting',last_accepted_at:this.lastAcceptedAt,sessions:[...this.sessions.values()], identity:'runtime-reported names; installed bytes not verified', capture:'since collector start; not a complete session history'}; }
}
