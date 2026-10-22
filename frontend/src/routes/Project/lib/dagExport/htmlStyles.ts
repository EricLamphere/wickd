import { MONO, SANS, type Palette } from './svg';

/** CSS for the interactive HTML export; the filter bar mirrors the app's DagFilterBar. */
export function htmlStyles(p: Palette): string {
  return `
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:${p.background};color:${p.text};font-family:${SANS}}
body{display:flex;flex-direction:column}
header{padding:16px 24px 12px;background:${p.headerBackground};border-bottom:1px solid ${p.border}}
h1{margin:0;font-size:18px}
.subtitle{margin:4px 0 8px;color:${p.muted};font-size:12px}
summary{cursor:pointer;color:${p.faint};font-size:12px;user-select:none}
dl{display:grid;grid-template-columns:max-content 1fr;gap:3px 24px;margin:8px 0 0;font-size:12px}
dt{color:${p.faint}}
dd{margin:0;font-family:${MONO};overflow-wrap:anywhere}
#filters{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 16px;background:${p.panel};border-bottom:1px solid ${p.border};font-size:12px}
#selector{flex:1;min-width:180px;max-width:520px;padding:6px 12px;font:13px ${SANS};color:${p.text};background:${p.background};border:1px solid ${p.border};border-radius:6px;outline:none}
#selector:focus{border-color:${p.brand}}
#dropdowns{display:contents}
.fd{position:relative}
.fd-btn,#clear,#reset{display:flex;align-items:center;gap:6px;padding:6px 10px;font:12px ${SANS};color:${p.muted};background:${p.background};border:1px solid ${p.border};border-radius:6px;cursor:pointer}
.fd-btn:hover,#clear:hover,#reset:hover{color:${p.text}}
.fd-btn.on{color:${p.brand};border-color:${p.brand}}
.fd-badge{min-width:16px;padding:0 5px;border-radius:8px;background:${p.brand};color:#fff;font-size:10px;line-height:16px;text-align:center}
.fd-chev{font-size:9px;opacity:.7}
.fd-menu{position:absolute;top:calc(100% + 4px);left:0;z-index:20;min-width:180px;max-height:300px;overflow:auto;padding:4px;background:${p.panel};border:1px solid ${p.border};border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.3)}
.fd-menu label{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:4px;color:${p.text};font-family:${MONO};font-size:11px;cursor:pointer;white-space:nowrap}
.fd-menu label:hover{background:${p.border}}
.fd-menu input{flex:none;margin:0;accent-color:${p.brand}}
#clear,#reset{border-color:transparent;background:none}
#count{margin-left:auto;color:${p.faint}}
main{position:relative;flex:1;min-height:0;overflow:hidden}
#graph{width:100%;height:100%;display:block;cursor:grab;user-select:none}
#graph.panning{cursor:grabbing}
#empty{position:absolute;top:45%;width:100%;text-align:center;color:${p.faint};font-size:13px;pointer-events:none}
.node{cursor:pointer}
.node,.edge{transition:opacity .15s}
.dim{opacity:.15}
.edge.hl{stroke:${p.brand};stroke-width:2.5}
.node.sel .box{stroke:${p.brand};stroke-width:3}
.col.hit .col-bg{fill:${p.brand};fill-opacity:.18}
.col.active .col-bg{fill:${p.brand};fill-opacity:.4}
#toolbar{position:absolute;top:12px;left:12px;display:flex;gap:6px;align-items:center}
#toolbar input,#toolbar button{font:12px ${SANS};color:${p.text};background:${p.panel};border:1px solid ${p.border};border-radius:6px;padding:6px 10px}
#toolbar input{width:200px}
#toolbar button{cursor:pointer}
#toolbar .hint{font-size:11px;color:${p.faint};margin-left:6px}
#panel{position:absolute;top:12px;right:12px;bottom:12px;width:320px;overflow:auto;padding:16px;background:${p.panel};border:1px solid ${p.border};border-radius:8px;font-size:12px}
#panel h2{margin:2px 0 10px;font-size:15px;overflow-wrap:anywhere}
#panel h3{margin:16px 0 6px;font-size:12px;color:${p.muted}}
#panel .close{position:absolute;top:8px;right:10px;border:0;background:none;color:${p.muted};font-size:18px;cursor:pointer}
.panel-type{font-family:${MONO};font-size:10px;color:${p.faint}}
.meta-row{display:flex;gap:8px;margin:2px 0}
.meta-label{color:${p.faint};min-width:100px}
.meta-value{font-family:${MONO};overflow-wrap:anywhere}
.desc{color:${p.muted};line-height:1.5;white-space:pre-wrap}
.counts,.hint{color:${p.faint}}
.cols{list-style:none;margin:0;padding:0;font-family:${MONO};font-size:11px}
.cols li{padding:3px 6px;border-radius:4px;color:${p.muted}}
.cols li.clickable{cursor:pointer}
.cols li.clickable:hover{background:${p.border}}
.cols li.active{background:${p.brand};color:#fff}
.trace{margin:6px 0}
.trace-node{border:0;background:none;padding:0;color:${p.brand};font:600 12px ${SANS};cursor:pointer}
.trace-node.hidden-node{color:${p.faint};cursor:default}
.trace-cols{font-family:${MONO};font-size:11px;color:${p.muted};overflow-wrap:anywhere}
#tooltip{position:absolute;pointer-events:none;max-width:320px;padding:8px 10px;background:${p.panel};border:1px solid ${p.border};border-radius:6px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.25)}
#tooltip div{color:${p.muted};margin-top:2px}
.tip-desc{max-height:80px;overflow:hidden}
[hidden]{display:none!important}
`;
}
