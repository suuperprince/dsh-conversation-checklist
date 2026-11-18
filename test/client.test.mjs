import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'

const flush=async()=>{await new Promise(setImmediate);await new Promise(setImmediate)}
const response=(id,tasks=[])=>({ok:true,status:200,json:async()=>({ok:true,checklist:{sessionId:id,tasks,tracking:true}})})
function browser(fetcher){
 const calls=[],timers=new Map()
 let now=0,next=0
 const window={__ModuleLoader__:{load(module){module.factory(()=>({}))}}}
 const source=readFileSync(new URL('../client.js',import.meta.url),'utf8').replace('    // -- open/anchor state','    window.store = createDataStore()\n    // -- open/anchor state')
 vm.runInNewContext(source,{window,AbortController,fetch:(url,opts)=>{calls.push({url,opts});return fetcher(url,opts)},
  setTimeout(fn,delay){const id=++next;timers.set(id,{fn,at:now+delay});return id},clearTimeout(id){timers.delete(id)}})
 return {store:window.store,calls,timers,async advance(ms){const end=now+ms;for(;;){const due=[...timers.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;timers.delete(due[0]);now=due[1].at;due[1].fn();await flush()}now=end;await flush()}}
}

test('the desktop client loads a snapshot without EventSource support',async()=>{
 const b=browser(async url=>response(new URL(url,'http://host').searchParams.get('sessionId'),[{text:'Run the tests',status:'todo'}]))
 b.store.view('chat-A');await flush()
 assert.equal(b.store.getSnapshot().phase,'ready')
 assert.equal(b.store.getSnapshot().checklist.tasks[0].text,'Run the tests')
 assert.equal(b.calls[0].opts.cache,'no-store')
 assert.ok(b.calls.every(c=>!c.url.includes('/stream')))
 b.store.dispose()
})

test('an open panel automatically refreshes completed tasks and stops polling when closed',async()=>{
 let status='todo'
 const b=browser(async()=>response('A',[{text:'Run the tests',status}]))
 b.store.view('A');b.store.setVisible(true);await flush()
 status='done';await b.advance(2000)
 assert.equal(b.store.getSnapshot().checklist.tasks[0].status,'done')
 b.store.setVisible(false)
 const count=b.calls.length
 await b.advance(10000)
 assert.equal(b.calls.length,count)
 b.store.setVisible(true);await flush()
 assert.equal(b.calls.length,count+1)
 b.store.dispose()
 assert.equal(b.timers.size,0)
})

test('an HTTP failure exits loading and a later retry recovers',async()=>{
 let available=false
 const b=browser(async()=>available?response('A'):{ok:false,status:503})
 b.store.view('A');b.store.setVisible(true);await flush()
 assert.equal(b.store.getSnapshot().phase,'error')
 assert.match(b.store.getSnapshot().error,/http-503/)
 available=true;await b.advance(4000)
 assert.equal(b.store.getSnapshot().phase,'ready')
 assert.equal(b.store.getSnapshot().error,null)
 b.store.dispose()
})

test('A-B-A navigation discards responses from the earlier visit to A',async()=>{
 const pending=[]
 const b=browser(()=>new Promise(resolve=>pending.push(resolve)))
 b.store.view('A');b.store.view('B');b.store.view('A')
 pending[0](response('A',[{text:'stale'}]));pending[1](response('B'))
 await flush();assert.equal(b.store.getSnapshot().checklist,null)
 pending[2](response('A',[{text:'current'}]));await flush()
 assert.equal(b.store.getSnapshot().checklist.tasks[0].text,'current')
 b.store.dispose()
})

test('manual actions cannot be overwritten by a snapshot started earlier',async()=>{
 let resolveRead,reads=0
 const b=browser(async(url,opts)=>{
  if(opts.method==='POST')return response('A',[{text:'Task',status:'done'}])
  reads++
  if(reads===1)return new Promise(resolve=>{resolveRead=resolve})
  return response('A',[{text:'Task',status:'done'}])
 })
 b.store.view('A');await flush()
 await b.store.act({kind:'complete',id:'task'});await flush()
 resolveRead(response('A',[{text:'Task',status:'todo'}]));await flush()
 assert.equal(b.store.getSnapshot().checklist.tasks[0].status,'done')
 b.store.dispose()
})

test('a snapshot for a different session is rejected',async()=>{
 const b=browser(async()=>response('wrong-session'))
 b.store.view('A');await flush()
 assert.equal(b.store.getSnapshot().phase,'error')
 assert.equal(b.store.getSnapshot().checklist,null)
 b.store.dispose()
})

test('a hung request times out and then retries',async()=>{
 let hung=true
 const b=browser(async(url,opts)=>{
  if(!hung)return response('A')
  return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))))
 })
 b.store.view('A');b.store.setVisible(true)
 await b.advance(10000)
 assert.equal(b.store.getSnapshot().phase,'error')
 assert.match(b.store.getSnapshot().error,/timed out/)
 hung=false;await b.advance(4000)
 assert.equal(b.store.getSnapshot().phase,'ready')
 b.store.dispose()
})

test('the rendered checklist exposes read-only status and strikes completed text',()=>{
 const React={createElement(type,props,...children){return {type,props:props??{},children:children.flat(Infinity)}},
  useSyncExternalStore(subscribe,snapshot){return snapshot()},useRef(){return {current:null}},
  useState(initial){return [initial,()=>{}]},useEffect(){}}
 const window={innerWidth:1000,innerHeight:800,__ModuleLoader__:{load(module){module.factory(name=>name==='react'?React:{createPortal:node=>node})}}}
 const source=readFileSync(new URL('../client.js',import.meta.url),'utf8').replace('    // -- plugin','    window.Panel = ChecklistPanel\n    // -- plugin')
 vm.runInNewContext(source,{window,document:{body:{}}})
 const node=window.Panel({sessionId:'A',ui:{subscribe(){},getSnapshot:()=>({openFor:'A',anchor:null})},
  data:{subscribe(){},getSnapshot:()=>({phase:'ready',checklist:{sessionId:'A',tasks:[{id:'task',parentId:null,text:'Run the tests',status:'done'}]}})}})
 const all=[]
 const walk=value=>{if(!value||typeof value!=='object')return;all.push(value);for(const child of value.children??[])walk(child)}
 walk(node)
 const check=all.find(n=>n.props.className==='ccl-check')
 assert.equal(check.type,'span')
 assert.equal(check.props['aria-readonly'],true)
 assert.equal(check.props['aria-checked'],true)
 assert.equal(check.props.onClick,undefined)
 const text=all.find(n=>n.props.className==='ccl-text')
 assert.equal(text.props['data-status'],'done')
 assert.ok(!all.some(n=>n.children?.some(child=>['Dismiss','Rename','Complete','Reopen','Accept','Add'].includes(child))))
 const css=all.find(n=>n.type.name==='Styles')
 assert.ok(css)
 const style=css.type()
 assert.match(style.children[0],/ccl-text\[data-status="done"\][^}]*text-decoration:line-through/)
})
