export function frameBridge(side, prefix = `/__${side}`) {
  const script = `(() => {
    const side=${JSON.stringify(side)},prefix=${JSON.stringify(prefix)};
    let linked=false,mirror=false;
    const send=(type,data={})=>parent.postMessage({source:'sitedrift-frame',side,type,...data},'*');
    const root=()=>document.scrollingElement||document.documentElement;
    const route=()=>location.pathname.replace(prefix,'')+location.search+location.hash||'/';
    const snapshot=()=>{
      const q=(s)=>document.querySelector(s);
      const imgs=[...document.querySelectorAll('img')];
      const title=(document.title||'').trim();
      const description=q('meta[name="description"]')?.content?.trim()||'';
      const canonical=q('link[rel="canonical"]')?.href||'';
      const navigation=performance.getEntriesByType('navigation')[0];
      const timing=navigation?{
        response:Math.round(navigation.responseEnd),
        dom:Math.round(navigation.domContentLoadedEventEnd),
        load:Math.round(navigation.loadEventEnd||navigation.duration),
        transfer:Number(navigation.transferSize)||0,
        decoded:Number(navigation.decodedBodySize)||0
      }:null;
      const checks=[
        ['Title present',!!title],['Title 30–60 chars',title.length>=30&&title.length<=60,title.length+''],
        ['Meta description',!!description],['Description 70–160',description.length>=70&&description.length<=160,description.length+''],
        ['Exactly one H1',document.querySelectorAll('h1').length===1,document.querySelectorAll('h1').length+' found'],
        ['Canonical link',!!q('link[rel="canonical"]')],['Viewport meta',!!q('meta[name="viewport"]')],
        ['html lang',!!document.documentElement.lang],['Open Graph title',!!q('meta[property="og:title"]')],
        ['Open Graph image',!!q('meta[property="og:image"]')],
        ['Not noindex',!(q('meta[name="robots"]')?.content||'').toLowerCase().includes('noindex')],
        ['Favicon',!!q('link[rel~="icon"]')],
        ['Images have alt',imgs.every((img)=>img.hasAttribute('alt')),imgs.filter((img)=>!img.hasAttribute('alt')).length+' missing']
      ].map(([label,ok,note])=>({label,ok,note}));
      send('ready',{route:route(),meta:{title,description,canonical,heading:q('h1')?.textContent?.trim()||'',
        siteName:q('meta[property="og:site_name"]')?.content?.trim()||'',icon:q('link[rel~="icon"]')?.href||'',checks,timing}});
      send('scroll',{y:scrollY,max:Math.max(0,root().scrollHeight-innerHeight)});
    };
    addEventListener('message',(event)=>{
      const msg=event.data||{};
      if(msg.source!=='sitedrift-parent'||msg.side!==side)return;
      if(msg.type==='settings'){linked=!!msg.linked;mirror=!!msg.mirror;document.documentElement.style.scrollBehavior='auto';}
      if(msg.type==='scroll'){root().scrollTop=msg.y;}
      if(msg.type==='reload')location.reload();
    });
    addEventListener('scroll',()=>send('scroll',{y:scrollY,max:Math.max(0,root().scrollHeight-innerHeight)}),{passive:true});
    addEventListener('wheel',(event)=>{if(!linked||!event.deltaY)return;event.preventDefault();send('wheel',{delta:event.deltaY,mode:event.deltaMode,height:innerHeight,y:scrollY});},{passive:false,capture:true});
    addEventListener('keydown',(event)=>{
      const typing=/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)||event.target.isContentEditable;
      if(!typing&&!event.metaKey&&!event.ctrlKey&&!event.altKey&&['r','s','0','/','o','d'].includes(event.key.toLowerCase())){
        event.preventDefault();send('key',{key:event.key.toLowerCase()});return;
      }
      if(linked&&!typing&&!event.metaKey&&!event.ctrlKey&&!event.altKey)send('key',{key:event.key,shift:event.shiftKey,y:scrollY,height:innerHeight,max:Math.max(0,root().scrollHeight-innerHeight)});
    },true);
    addEventListener('click',(event)=>{
      send('dismiss');
      if(!mirror||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
      const link=event.target.closest('a[href]');if(!link||link.target==='_blank'||link.hasAttribute('download'))return;
      const url=new URL(link.href,location.href);if(url.origin!==location.origin||!url.pathname.startsWith(prefix))return;
      event.preventDefault();send('navigate',{route:url.pathname.slice(prefix.length)||'/'});
    },true);
    addEventListener('DOMContentLoaded',snapshot,{once:true});if(document.readyState!=='loading')snapshot();
  })();`;
  return `<script>${script.replace(/<\//g, '<\\/')}</script>`;
}

export function rewriteRootPaths(body, prefix) {
  return body
    .replace(/(\b(?:href|src|action|poster)=["'])\/(?!\/)/gi, `$1${prefix}/`)
    .replace(/\bsrcset=(["'])(.*?)\1/gi, (attribute, quote, value) => {
      const rewritten = value.replace(/(^|,\s*)\/(?!\/)/g, `$1${prefix}/`);
      return `srcset=${quote}${rewritten}${quote}`;
    })
    .replace(/url\((["']?)\/(?!\/)/gi, `url($1${prefix}/`)
    .replace(/(["'`])\/(@(?:id|vite|fs)\/|_astro\/)/g, `$1${prefix}/$2`);
}
