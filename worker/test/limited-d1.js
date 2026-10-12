// Real SQLite limits also apply to intermediate values and transaction records,
// which a wrapper checking only bound string lengths would miss.
export class LimitedD1 {
  // realNumbers: bind every JS number as a REAL, as D1 does (1999 -> 1999.0).
  constructor({realNumbers=false} = {}) {
    this.process = Bun.spawn(['uv', 'run', '--quiet', '--project', `${import.meta.dir}/../..`,
      'python', '-B', `${import.meta.dir}/fixtures/limited_d1.py`, ...(realNumbers ? ['--real-numbers'] : [])],
      {stdin:'pipe',stdout:'pipe',stderr:'inherit'});
    this.reader = this.process.stdout.getReader();
    this.decoder = new TextDecoder();
    this.buffer = '';
    this.pending = Promise.resolve();
  }
  request(message) {
    const result=this.pending.then(()=>this.exchange(message));
    this.pending=result.catch(()=>{});
    return result;
  }
  async exchange(message) {
    this.process.stdin.write(JSON.stringify(message)+'\n');
    await this.process.stdin.flush();
    while (!this.buffer.includes('\n')) {
      const {value,done} = await this.reader.read();
      if (done) throw new Error('SQLite fixture exited');
      this.buffer += this.decoder.decode(value,{stream:true});
    }
    const end = this.buffer.indexOf('\n'), line = this.buffer.slice(0,end);
    this.buffer = this.buffer.slice(end+1);
    const out = JSON.parse(line);
    if (out.error) throw new Error(out.error);
    return out.result;
  }
  prepare(sql) {
    const db = this;
    return {sql,args:[],bind(...args){this.args=args;return this;},
      all(){return db.request(this);}, run(){return db.request(this);},
      async first(){return (await db.request(this)).results[0]??null;},
      async raw({columnNames=false}={}){
        const out=await db.request(this), rows=out.results.map(row=>Object.values(row));
        return columnNames?[out.columns,...rows]:rows;
      }};
  }
  batch(statements) { return this.request({batch:statements}); }
  async close() { await this.pending;this.process.stdin.end();await this.process.exited; }
}
