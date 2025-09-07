// Node version of streaming Markdown parser with finalize
const TAG = {"**":"strong","__":"strong","*":"em","_":"em","~~":"del"};
const openTag = t => `<${t}>`;
const closeTag = t => `</${t}>`;
function esc(s){
  return s.replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[ch]));
}

// tokenization
function* scanInline(src){
  let i=0,N=src.length;
  while(i<N){
    const ch=src[i];
    if(ch==='\\' && i+1<N){ yield {type:'text', value:src[i+1]}; i+=2; continue; }
    if(ch==='`'){ let j=i; while(j<N && src[j]==='`') j++; const len=j-i; i=j; yield {type:'ticks', len}; continue; }
    const two=(i+1<N)?ch+src[i+1]:'';
    if(two==='**'||two==='__'||two==='~~'){ yield {type:'delim', value:two}; i+=2; continue; }
    if(ch==='*'||ch==='_'||ch==='~'){ yield {type:'delim', value:ch}; i++; continue; }
    let k=i; while(k<N && !"\\`*_~".includes(src[k])) k++; yield {type:'text', value:src.slice(i,k)}; i=k;
  }
}

// global state
const S={
  inlineStack:[],
  pendingTicks:null,
  boundaryHalf:"",
  boundaryPair:"",
  block:{
    listStack:[],
    inParagraph:false,
    table:null,
    fenced:null
  },
  lineBuffer:""
};

function openInlineDelim(state,sig){
  if(sig==='*'||sig==='_' ){ state.inlineStack.push({kind:'em',sig}); return openTag('em'); }
  if(sig==='**'||sig==='__'){ state.inlineStack.push({kind:'strong',sig}); return openTag('strong'); }
  if(sig==='~~'){ state.inlineStack.push({kind:'del',sig}); return openTag('del'); }
  return '';
}
function closeInlineDelim(state,sig){
  for(let i=state.inlineStack.length-1;i>=0;i--){
    if(state.inlineStack[i].sig===sig){
      const above=state.inlineStack.splice(i+1);
      let out=above.map(t=>closeTag(t.kind)).reverse().join('');
      const tok=state.inlineStack.pop(); out+=closeTag(tok.kind);
      out+=above.map(t=>openTag(t.kind)).join('');
      return out;
    }
  }
  return esc(sig);
}

function handleInline(line,state){
  let out="";
  const tokens=[...scanInline(line)];

  // A) settle single delimiter from previous chunk
  if(state.boundaryHalf){
    const firstTok=tokens[0];
    const firstText=firstTok?.type==='text'?firstTok.value:(firstTok?.type==='delim'?firstTok.value:'');
    const firstChar=firstText?firstText[0]:'';
    const pair=state.boundaryHalf+firstChar;
    if(pair==='**'||pair==='__'||pair==='~~'){
      const top=state.inlineStack[state.inlineStack.length-1];
      out+=(top&&top.sig===pair)?closeInlineDelim(state,pair):openInlineDelim(state,pair);
      if(tokens.length && tokens[0].type==='text') tokens[0].value=tokens[0].value.slice(1);
    } else {
      out+=esc(state.boundaryHalf);
    }
    state.boundaryHalf="";
  }

  // B) settle pair delimiter from previous chunk
  if(state.boundaryPair){
    const pair=state.boundaryPair; state.boundaryPair="";
    const top=state.inlineStack[state.inlineStack.length-1];
    out+=(top&&top.sig===pair)?closeInlineDelim(state,pair):openInlineDelim(state,pair);
  }

  for(let i=0;i<tokens.length;i++){
    const t=tokens[i];
    if(state.pendingTicks && t.type!=='ticks'){
      if(t.type==='text') out+=esc(t.value); else if(t.type==='delim') out+=esc(t.value);
      continue;
    }
    if(t.type==='text'){ out+=esc(t.value); continue; }
    if(t.type==='ticks'){
      if(!state.pendingTicks){ state.pendingTicks=t.len; out+=openTag('code'); }
      else if(t.len===state.pendingTicks){ state.pendingTicks=null; out+=closeTag('code'); }
      else { out+=esc('`'.repeat(t.len)); }
      continue;
    }
    if(t.type==='delim'){
      const isLast=(i===tokens.length-1);
      if((t.value==='*'||t.value==='_'||t.value==='~') && isLast){ state.boundaryHalf=t.value; continue; }
      if((t.value==='**'||t.value==='__'||t.value==='~~') && isLast){ state.boundaryPair=t.value; continue; }
      const top=state.inlineStack[state.inlineStack.length-1];
      if(top && top.sig===t.value){ out+=closeInlineDelim(state,t.value); }
      else {
        if(t.value==='_'||t.value==='__'){
          const prev=tokens[i-1]?.type==='text'?tokens[i-1].value.slice(-1):'';
          const next=tokens[i+1]?.type==='text'?tokens[i+1].value[0]:'';
          if(/\w/.test(prev) && /\w/.test(next)){ out+=esc(t.value); continue; }
        }
        out+=openInlineDelim(state,t.value);
      }
    }
  }
  return out;
}

function openParagraphIfNeeded(state){ if(!state.block.inParagraph){ state.block.inParagraph=true; return '<p>'; } return ''; }
function closeParagraphIfOpen(state){ if(state.block.inParagraph){ state.block.inParagraph=false; return '</p>'; } return ''; }

function unwindListsToIndent(state,indent){
  let out=''; const stk=state.block.listStack;
  while(stk.length){
    const t=stk[stk.length-1];
    if(t.type==='li' && t.indent>=indent){ stk.pop(); out+='</li>'; continue; }
    if((t.type==='ul'||t.type==='ol') && t.indent>indent){ stk.pop(); out+=`</${t.type}>`; continue; }
    break;
  }
  return out;
}
function ensureListContainer(state,indent,listType){
  let html=''; html+=unwindListsToIndent(state,indent);
  const stk=state.block.listStack; const top=stk[stk.length-1];
  if(top && (top.type==='ul'||top.type==='ol') && top.indent===indent && top.type!==listType){ stk.pop(); html+=`</${top.type}>`; }
  const cur=stk[stk.length-1]; if(!cur||cur.type!==listType||cur.indent!==indent){ stk.push({type:listType,indent}); html+=`<${listType}>`; }
  return html;
}
function handleListLine(line,state){
  const m=/^(\s*)([\*\+\-]|\d+\.)\s+(.*)$/.exec(line); if(!m) return null;
  const indent=m[1].length, marker=m[2], rest=m[3]; const listType=/\d+\./.test(marker)?'ol':'ul';
  let html='';
  html+=closeParagraphIfOpen(state);
  html+=ensureListContainer(state,indent,listType);
  const stk=state.block.listStack; const top=stk[stk.length-1]; if(top && top.type==='li' && top.indent===indent){ stk.pop(); html+='</li>'; }
  stk.push({type:'li', parent:listType, indent}); html+='<li>'+handleInline(rest,state);
  return html;
}
function closeAllLists(state){ let out=''; const stk=state.block.listStack; while(stk.length){ const t=stk.pop(); out+=(t.type==='li')?'</li>':`</${t.type}>`; } return out; }

// tables with safe splitting
function splitTableLineSafe(line){
  const cells=[]; let cur=""; let openRun=0;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='`'){
      let j=i; while(j<line.length && line[j]==='`') j++; const len=j-i;
      if(openRun===0) openRun=len; else if(len===openRun) openRun=0;
      cur+=line.slice(i,j); i=j-1; continue;
    }
    if(ch==='|' && openRun===0){ cells.push(cur.trim()); cur=""; continue; }
    cur+=ch;
  }
  cells.push(cur.trim()); return cells;
}
function isTableSep(line){ const parts=splitTableLineSafe(line); if(parts.length<2) return false; return parts.every(c=>!c || /^:?-{3,}:?$/.test(c)); }
function parseAligns(sepLine){ const parts=splitTableLineSafe(sepLine); return parts.map(s=>{ s=s.trim(); if(!s) return null; const L=s.startsWith(':'), R=s.endsWith(':'); if(L&&R) return 'center'; if(R) return 'right'; if(L) return 'left'; return null; }); }
function handleTableStart(lines,idx,state){
  const headerLine=lines[idx], sepLine=lines[idx+1];
  if(!headerLine?.includes('|') || !sepLine || !isTableSep(sepLine)) return null;
  const header=splitTableLineSafe(headerLine); const aligns=parseAligns(sepLine);
  let html=closeParagraphIfOpen(state);
  html+='<table><thead><tr>'+header.map((c,i)=>{
    const savedStack=state.inlineStack.slice();
    const savedTicks=state.pendingTicks; const savedHalf=state.boundaryHalf; const savedPair=state.boundaryPair;
    const cellHTML=handleInline(c,state);
    state.inlineStack=savedStack; state.pendingTicks=savedTicks; state.boundaryHalf=savedHalf; state.boundaryPair=savedPair;
    return `<th${aligns[i]?` style="text-align:${aligns[i]}"`:''}>${cellHTML}</th>`;
  }).join('')+'</tr></thead><tbody>';
  state.block.table={active:true, aligns};
  return {html, advance:2};
}

function fenceOpen(line){ const m=/^(\s*)(`{3,}|~{3,})(\s*\w+)?\s*$/.exec(line); if(!m) return null; const ticks=m[2][0]; const len=m[2].length; const lang=(m[3]||'').trim(); return {fence:ticks.repeat(len), ticks:len, lang:lang||''}; }

function processLines(lines,state){
  let html="";
  for(let i=0;i<lines.length;i++){
    let line=lines[i];
    if(state.block.fenced){
      const m=/^(\s*)(`{3,}|~{3,})\s*$/.exec(line);
      if(m && m[2][0].repeat(m[2].length)===state.block.fenced.fence){ html+='</code></pre>'; state.block.fenced=null; continue; }
      html+=esc(line)+"\n"; continue;
    }
    const fo=fenceOpen(line);
    if(fo){ const cls=fo.lang?` class="language-${esc(fo.lang)}"`:''; html+=closeParagraphIfOpen(state); state.block.fenced=fo; html+=`<pre><code${cls}>`; continue; }
    if(!state.block.table){ const t=handleTableStart(lines,i,state); if(t){ html+=t.html; i+=t.advance; continue; } }
    else {
      if(line.trim()==='' || !line.includes('|')){ html+='</tbody></table>'; state.block.table=null; }
      else {
        const cells=splitTableLineSafe(line); const aligns=state.block.table.aligns;
        html+='<tr>'+cells.map((c,ci)=>{
          const savedStack=state.inlineStack.slice(); const savedTicks=state.pendingTicks; const savedHalf=state.boundaryHalf; const savedPair=state.boundaryPair;
          const cellHTML=handleInline(c,state);
          state.inlineStack=savedStack; state.pendingTicks=savedTicks; state.boundaryHalf=savedHalf; state.boundaryPair=savedPair;
          return `<td${aligns[ci]?` style="text-align:${aligns[ci]}"`:''}>${cellHTML}</td>`;
        }).join('')+'</tr>';
        continue;
      }
    }
    const li=handleListLine(line,state);
    if(li){ html+=li; continue; }
    else if(line.trim()==='' && state.block.listStack.length){ html+=closeAllLists(state); continue; }
    if(/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(line)){ html+=closeParagraphIfOpen(state)+'<hr>'; continue; }
    const qm=/^>\s?(.*)$/.exec(line); if(qm){ html+=closeParagraphIfOpen(state)+'<blockquote>'+handleInline(qm[1],state)+'</blockquote>'; continue; }
    const hm=/^(#{1,6})\s+(.*)$/.exec(line); if(hm){ html+=closeAllLists(state)+closeParagraphIfOpen(state)+`<h${hm[1].length}>${handleInline(hm[2],state)}</h${hm[1].length}>`; continue; }
    if(line.trim()===''){ html+=closeParagraphIfOpen(state); continue; }
    html+=openParagraphIfNeeded(state)+handleInline(line,state);
  }
  return html;
}

function processChunk(input,state){ state.lineBuffer+=input; const parts=state.lineBuffer.split('\n'); state.lineBuffer=parts.pop(); return processLines(parts,state); }

function finalize(state){
  let html='';
  if(state.lineBuffer!==''){ html+=processLines([state.lineBuffer],state); state.lineBuffer=''; }
  html+=handleInline('',state);
  if(state.block.table){ html+='</tbody></table>'; state.block.table=null; }
  html+=closeAllLists(state);
  html+=closeParagraphIfOpen(state);
  if(state.block.fenced){ html+='</code></pre>'; state.block.fenced=null; }
  return html;
}

// demo chunks
const chunks=[
  // simple demo: open <strong> in first chunk, close in second
  {role:'model', content:'**witam'},
  {role:'model', content:' co tam**'}
];

let cumulativeHTML=""; let idx=0;
for(const chunk of chunks){
  const html=processChunk(chunk.content + '\n', S);
  cumulativeHTML += html;
  console.log(`chunk ${++idx}:`, cumulativeHTML);
}
cumulativeHTML += finalize(S);

const voidTags=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
function checkHtmlBalance(html){
  const stack=[]; const tagRegex=/<\/?([a-zA-Z0-9]+)(\s[^>]*)?>/g; let match;
  while((match=tagRegex.exec(html))){
    const tag=match[1].toLowerCase();
    const isClosing=match[0][1]=='/';
    if(voidTags.has(tag)) continue;
    if(isClosing){ if(stack.pop()!==tag) return false; }
    else { stack.push(tag); }
  }
  return stack.length===0;
}
const balanced=checkHtmlBalance(cumulativeHTML);
console.log('Final HTML:', cumulativeHTML);
console.log('Balanced tags:', balanced);
