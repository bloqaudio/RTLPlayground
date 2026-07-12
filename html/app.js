"use strict";
/* ============================================================
 * state
 * ============================================================ */
var S={
  ports:[],n:0,physToLog:[],logToPhys:[],sfpSlot:[],info:{},
  dirty:false,prev:null,prevT:0,rates:[],mtu:[],
  cfgKnown:{stp:false,igmp:false,syslogOn:false,syslogIp:""},
};
var LINKS=["Down","10M","100M","1000M","500M","10G","2.5G","5G"];
var LINKC=[null,"--s10","--s100","--s1000","--s5g","--s10g","--s2g5","--s5g"];
var $=function(id){return document.getElementById(id)};
function h(tag,attrs,kids){
  var e=document.createElement(tag);
  if(attrs)for(var k in attrs){
    if(k==="text")e.textContent=attrs[k];
    else if(k==="html")e.innerHTML=attrs[k];
    else if(k.slice(0,2)==="on")e.addEventListener(k.slice(2),attrs[k]);
    else e.setAttribute(k,attrs[k]);
  }
  if(kids)kids.forEach(function(c){e.appendChild(c)});
  return e;
}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}

/* ============================================================
 * themes
 * ============================================================ */
function applyTheme(){
  var pref;
  try{pref=localStorage.getItem("theme")||"auto";}catch(e){pref="auto";}
  var dark=window.matchMedia("(prefers-color-scheme: dark)").matches;
  var t=pref;
  if(pref==="auto")t=dark?"dark":"light";
  if(pref==="auto-sel")t=dark?"sel-dark":"sel-light";
  document.documentElement.dataset.theme=t;
  $("themeSel").value=pref;
}
$("themeSel").addEventListener("change",function(){
  try{localStorage.setItem("theme",this.value);}catch(e){}
  applyTheme();
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",applyTheme);
applyTheme();

/* ============================================================
 * serialized fetch queue. The firmware sends no Content-Length
 * and delimits each response by closing the connection, and it
 * shares one output buffer across connections — so the queue
 * must hold the next request until the previous BODY is fully
 * received (fetch() alone resolves at headers), matching the
 * old XHR queue's readyState-4 behavior.
 * api() resolves with {ok, status, body}.
 * ============================================================ */
var _q=Promise.resolve();
function api(path,opts){
  return new Promise(function(resolve,reject){
    _q=_q.then(function(){
      opts=opts||{};
      var ctl=("AbortController"in window)?new AbortController():null;
      if(ctl)opts.signal=ctl.signal;
      var to=setTimeout(function(){if(ctl)ctl.abort()},10000);
      return fetch(path,opts).then(function(r){
        if(r.status===401){clearTimeout(to);location.href="/login.html";throw new Error("auth");}
        return r.text().then(function(body){
          clearTimeout(to);
          resolve({ok:r.ok,status:r.status,body:body});
        });
      }).catch(function(e){clearTimeout(to);reject(e)});
    });
  });
}
function getJSON(p){return api(p).then(function(r){if(!r.ok)throw new Error(p+" → "+r.status);return JSON.parse(r.body)})}
function getText(p){return api(p).then(function(r){if(!r.ok)throw new Error(p+" → "+r.status);return r.body})}

/* persistable-command detection: successful /cmd of one of these
 * marks the running config dirty vs. flash */
var CONF_CMDS=[
  /^ip\s+(\d{1,3}\.){3}\d{1,3}$/,/^ip\s+dhcp$/,
  /^gw\s+(\d{1,3}\.){3}\d{1,3}$/,/^netmask\s+(\d{1,3}\.){3}\d{1,3}$/,
  /^syslog\s+(on|off)$/,/^syslog\s+ip\s+(\d{1,3}\.){3}\d{1,3}$/,
  /^passwd\s+\S+$/,/^hostname\s+\S+$/,
  /^vlan\s+\d{1,4}\s+d$/,/^vlan\s+\d{1,4}\s+mgmt$/,
  /^vlan\s+\d{1,4}(\s+[a-zA-Z]\w*)?(\s+\d{1,2}[tu]?)+$/,
  /^pvid\s+\d{1,2}\s+\d{1,4}$/,
  /^ingress(\s+\d{1,2}[tua])+$/,/^ingress\s+[tua]$/,
  /^port\s+\d{1,2}\s+(10m|100m|1g|2g5|5g|10g|auto|on|off)(\s+(half|full))?$/,
  /^port\s+\d{1,2}\s+name\s+\S+$/,
  /^eee(\s+\d{1,2})?\s+(on|off)$/,
  /^mirror(\s+\d{1,2})(\s+\d{1,2}[tr]?)+$/,
  /^lag\s+\d(\s+\d{1,2})+$/,/^laghash\s+\d(\s+\w+)+$/,
  /^isolate\s+\d{1,2}(\s+(off|\d{1,2}))+$/,
  /^stp\s+(on|off)$/,/^igmp\s+(on|off)$/,
  /^mtu\s+\d{1,2}\s+\d+$/,
  /^bw\s+(in|out)\s+\d{1,2}\s+\S+$/,
];
function isConfCmd(line){
  for(var i=0;i<CONF_CMDS.length;i++)if(CONF_CMDS[i].test(line))return true;
  return false;
}
function setDirty(d){
  S.dirty=d;
  $("dirty").classList.toggle("show",d);
}
function postCmd(cmd,quiet){
  return api("/cmd",{method:"POST",body:cmd}).then(function(r){
    if(!r.ok)throw new Error(((r.body||"").split("\n")[0])||("command rejected: "+cmd));
    if(isConfCmd(cmd.trim()))setDirty(true);
    if(!quiet)toast("Applied: "+cmd,"ok");
    return r;
  },function(e){toast(e.message||("failed: "+cmd),"err");throw e;});
}
function postCmds(list){
  var p=Promise.resolve();
  list.forEach(function(c){p=p.then(function(){return postCmd(c,true)})});
  return p.then(function(){toast(list.length+" command"+(list.length>1?"s":"")+" applied","ok")});
}

/* ============================================================
 * toasts + modal
 * ============================================================ */
function toast(msg,cls){
  var t=h("div",{class:"toast "+(cls||""),text:msg});
  $("toasts").appendChild(t);
  setTimeout(function(){t.style.opacity="0";t.style.transition="opacity .3s";},3400);
  setTimeout(function(){t.remove()},3800);
}
function modal(title,bodyEl,buttons){
  $("mtitle").textContent=title;
  var b=$("mbody");b.innerHTML="";b.appendChild(bodyEl);
  var f=$("mfoot");f.innerHTML="";
  (buttons||[]).forEach(function(bt){f.appendChild(bt)});
  $("mback").classList.add("show");
}
function closeModal(){$("mback").classList.remove("show")}
$("mx").addEventListener("click",closeModal);
$("mback").addEventListener("click",function(e){if(e.target===this)closeModal()});

/* ============================================================
 * router
 * ============================================================ */
var TABS=[
  {id:"dash",  label:"Dashboard",  icon:"M3 13h4v8H3zM10 8h4v13h-4zM17 3h4v18h-4z"},
  {id:"ports", label:"Ports",      icon:"M2 7h20v10H2zM6 11v2M10 11v2M14 11v2M18 11v2"},
  {id:"stats", label:"Statistics", icon:"M4 20V10M10 20V4M16 20v-7M22 20H2"},
  {id:"vlan",  label:"VLANs",      icon:"M12 3v6M12 9l-7 5M12 9l7 5M5 14v5M19 14v5M3 21h4M17 21h4"},
  {id:"l2",    label:"MAC table",  icon:"M4 5h16M4 12h16M4 19h10"},
  {id:"mirror",label:"Mirroring",  icon:"M12 3v18M7 8l-4 4 4 4M17 8l4 4-4 4"},
  {id:"lag",   label:"LAG",        icon:"M7 8a4 4 0 100 8h3M17 8a4 4 0 110 8h-3M9 12h6"},
  {id:"eee",   label:"EEE",        icon:"M13 2L4 14h6l-1 8 9-12h-6z"},
  {id:"bw",    label:"Bandwidth",  icon:"M4 18a8 8 0 0116 0M12 18l4-6"},
  {id:"system",label:"System",     icon:"M12 8a4 4 0 100 8 4 4 0 000-8zM4 12h2M18 12h2M12 4v2M12 18v2M6 6l1.5 1.5M16.5 16.5L18 18M18 6l-1.5 1.5M7.5 16.5L6 18"},
  {id:"fw",    label:"Firmware",   icon:"M12 3v12M8 11l4 4 4-4M4 19h16"},
];
var curTab="dash";
var tabHooks={}; /* id → {enter,leave,status} — filled by feature modules */
function showTab(id){
  var old=tabHooks[curTab];
  if(old&&old.leave)old.leave();
  curTab=id;
  TABS.forEach(function(t){
    $("tab-"+t.id).classList.toggle("act",t.id===id);
    $("nv-"+t.id).classList.toggle("act",t.id===id);
  });
  $("ttitle").textContent=TABS.filter(function(t){return t.id===id})[0].label;
  $("nav").classList.remove("open");
  if(location.hash!=="#"+id)history.replaceState(null,"","#"+id);
  var hk=tabHooks[id];
  if(hk&&hk.enter)hk.enter();
}
TABS.forEach(function(t){
  $("navlist").appendChild(h("li",{id:"nv-"+t.id,onclick:function(){showTab(t.id)}},[
    h("span",{html:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="'+t.icon+'"/></svg>'}),
    h("span",{text:t.label}),
  ]));
});
$("burger").addEventListener("click",function(){$("nav").classList.toggle("open")});

/* ============================================================
 * pollers — setTimeout-chained so slow responses never pile up
 * ============================================================ */
function Poller(fn,ms){this.fn=fn;this.ms=ms;this.on=false;this.t=null}
Poller.prototype.start=function(){if(this.on)return;this.on=true;this.tick()};
Poller.prototype.stop=function(){this.on=false;clearTimeout(this.t)};
Poller.prototype.tick=function(){
  var self=this;
  if(!self.on)return;
  var run=document.hidden?Promise.resolve():Promise.resolve().then(self.fn).catch(function(){});
  run.then(function(){ if(self.on)self.t=setTimeout(function(){self.tick()},self.ms); });
};

/* ============================================================
 * status model — shared by dashboard/ports/stats
 * ============================================================ */
function pollStatus(){
  return getJSON("/status.json").then(function(s){
    var now=Date.now();
    if(!S.n){
      S.n=s.length;
      var slot=0;
      s.forEach(function(p){
        S.physToLog[p.portNum-1]=p.logPort;
        S.logToPhys[p.logPort]=p.portNum;
        if(p.isSFP){slot++;S.sfpSlot[p.portNum-1]=slot;}
      });
      buildStrip();
    }
    /* pps rates from packet-counter deltas */
    if(S.prev){
      var dt=(now-S.prevT)/1000;
      if(dt>0.2)s.forEach(function(p,i){
        var q=S.prev[i];
        if(q)S.rates[p.portNum-1]={
          tx:Number(BigInt(p.txG)-BigInt(q.txG))/dt,
          rx:Number(BigInt(p.rxG)-BigInt(q.rxG))/dt,
        };
      });
    }
    S.prev=s;S.prevT=now;S.ports=s;
    updateStrip();
    var hk=tabHooks[curTab];
    if(hk&&hk.status)hk.status();
  });
}
var statusPoller=new Poller(pollStatus,2500);

function fmtPps(v){
  if(v==null)return"–";
  if(v>=1e6)return(v/1e6).toFixed(1)+" M";
  if(v>=1e3)return(v/1e3).toFixed(1)+" k";
  return Math.round(v);
}
function portLabel(p){return p.name?p.portNum+" · "+p.name:String(p.portNum)}

/* ---------- port strip ---------- */
function buildStrip(){
  var st=$("strip");st.innerHTML="";
  S.ports.length||(st.textContent="");
  for(var i=0;i<S.n;i++)(function(i){
    var p=S.ports[i]||{};
    st.appendChild(h("div",{class:"port"+(p.isSFP?" sfp":""),id:"pp"+i,onclick:function(){portDetail(i)}},[
      h("span",{class:"pn",text:String(i+1)}),
      h("i",{class:"jack"}),
      h("span",{class:"ps",id:"ppl"+i,text:"…"}),
    ]));
  })(i);
}
function updateStrip(){
  S.ports.forEach(function(p){
    var i=p.portNum-1,el=$("pp"+i),lb=$("ppl"+i);
    if(!el)return;
    el.classList.toggle("dis",!p.enabled);
    var up=p.enabled&&p.link>0;
    el.classList.toggle("up",!!up);
    if(up)el.style.setProperty("--pc","var("+(LINKC[p.link]||"--s1000")+")");
    lb.textContent=!p.enabled?"off":(p.link>0?LINKS[p.link]:"down");
    el.title=(p.name?p.name+" — ":"")+(p.isSFP?"SFP":"RJ45");
  });
}

/* ---------- SFP DOM decoding (verbatim math from legacy UI) ---------- */
function pU16(v){return parseInt(v,16)&0xffff}
function pI16(v){var x=parseInt(v,16),n=x&0x7fff;return(x&0x8000)?n-0x8000:n}
function calSO(val,cal){
  if(typeof cal!=="string")return val;
  if(cal.slice(0,2)==="0x")cal=cal.slice(2);
  if(cal.length!==8)return val;
  return(pU16(cal.slice(0,4))/256)*val+pI16(cal.slice(4,8));
}
function calRx(val,cal){
  if(typeof cal!=="string")return val;
  if(cal.slice(0,2)==="0x")cal=cal.slice(2);
  if(cal.length!==40)return val;
  var b=cal.match(/.{2}/g).map(function(x){return parseInt(x,16)});
  var v=new DataView(new Uint8Array(b).buffer);
  return v.getFloat32(0)*Math.pow(val,4)+v.getFloat32(4)*Math.pow(val,3)
    +v.getFloat32(8)*Math.pow(val,2)+v.getFloat32(12)*val+v.getFloat32(16);
}
function dBm(mw){return 10*Math.log10(mw)}
function portDetail(i){
  var p=S.ports[i];
  if(!p)return;
  var rows=[["Port",String(p.portNum)],["Type",p.isSFP?"SFP":"RJ45"]];
  if(p.name)rows.push(["Name",p.name]);
  rows.push(["State",!p.enabled?"disabled":(p.link>0?"up — "+LINKS[p.link]:"down")]);
  rows.push(["TX good / bad",BigInt(p.txG)+" / "+BigInt(p.txB)+" pkts"]);
  rows.push(["RX good / bad",BigInt(p.rxG)+" / "+BigInt(p.rxB)+" pkts"]);
  if(p.isSFP){
    if(p.sfp_vendor)rows.push(["Module",[p.sfp_vendor,p.sfp_model,p.sfp_serial].filter(Boolean).join(" · ")]);
    var ext=p.sfp_options&0x40;
    if(ext){
      var tx=calSO(pU16(p.sfp_txpower),p.sfp_txpower_cal)/10000;
      var rx=calRx(pU16(p.sfp_rxpower),p.sfp_rxpower_cal)/10000;
      rows.push(["Temperature",(calSO(pI16(p.sfp_temp),p.sfp_temp_cal)/256).toFixed(1)+" °C"]);
      rows.push(["Vcc",(calSO(pU16(p.sfp_vcc),p.sfp_vcc_cal)/10000).toFixed(2)+" V"]);
      rows.push(["TX bias",(calSO(pU16(p.sfp_txbias),p.sfp_txbias_cal)/500).toFixed(1)+" mA"]);
      rows.push(["TX power",tx.toFixed(3)+" mW / "+dBm(tx).toFixed(2)+" dBm"]);
      rows.push(["RX power",rx.toFixed(3)+" mW / "+dBm(rx).toFixed(2)+" dBm"]);
      rows.push(["TX fault",String(!!(Number(p.sfp_state)&0x4))]);
      rows.push(["TX disabled",String(!!(Number(p.sfp_state)&0x80))]);
    }
    var losPin=(p.sfp_los!=null)?!!Number(p.sfp_los):null;
    var losMod=ext?!!(Number(p.sfp_state)&0x2):null;
    if(losPin!=null||losMod!=null){
      var v=(losMod!=null&&losPin!=null&&losMod!==losPin)
        ?("pin="+losPin+" mod="+losMod+" ⚠"):String(losMod!=null?losMod:losPin);
      rows.push(["RX LOS",v]);
    }
  }else if(p.adv){
    var bits=parseInt(p.adv,2),names=["10M half","10M full","100M half","100M full","1G","2.5G"];
    var on=names.filter(function(_,b){return bits&(1<<b)});
    rows.push(["Advertising",on.join(", ")||"–"]);
  }
  var tb=h("table",{class:"t"});
  rows.forEach(function(r){
    tb.appendChild(h("tr",null,[h("td",{class:"mut",text:r[0]}),h("td",{text:r[1]})]));
  });
  modal("Port "+(i+1),tb);
}

/* ============================================================
 * dashboard
 * ============================================================ */
function renderInfo(){
  var m=[["Hostname","hostname"],["IP address","ip_address"],["Netmask","ip_netmask"],
    ["Gateway","ip_gateway"],["MAC","mac_address"],["Firmware","sw_ver"],["Built","build_date"],
    ["Hardware","hw_ver"],["Flash","flash_size"],["Syslog","syslog_server_ip"]];
  var t=$("sysinfo");t.innerHTML="";
  m.forEach(function(r){
    var v=S.info[r[1]];
    if(v==null||v==="")return;
    t.appendChild(h("tr",null,[h("td",{class:"mut",text:r[0]}),h("td",{class:"mono",text:String(v)})]));
  });
  if(S.info.hostname!=null){
    $("brandname").textContent=S.info.hostname||"Switch";
    $("hostrow").style.display="";
  }
  if(S.info.sw_ver)$("fver").textContent="RTLPlayground "+S.info.sw_ver;
}
function pollInfo(){
  return getJSON("/information.json").then(function(j){S.info=j;renderInfo()});
}
function dashStatus(){
  var tb=$("traffic").tBodies[0];
  if(tb.rows.length!==S.n){
    tb.innerHTML="";
    for(var i=0;i<S.n;i++){
      var tr=tb.insertRow();
      for(var c=0;c<6;c++)tr.insertCell().className=c>=2?"num":"";
    }
  }
  S.ports.forEach(function(p){
    var r=tb.rows[p.portNum-1];
    if(!r)return;
    var rt=S.rates[p.portNum-1];
    r.cells[0].textContent=portLabel(p);
    r.cells[1].innerHTML=!p.enabled?'<span class="badge">off</span>'
      :(p.link>0?'<span class="badge ok">'+LINKS[p.link]+"</span>":'<span class="badge">down</span>');
    r.cells[2].textContent=rt?fmtPps(rt.tx):"–";
    r.cells[3].textContent=rt?fmtPps(rt.rx):"–";
    r.cells[4].textContent=BigInt(p.txB).toString();
    r.cells[5].textContent=BigInt(p.rxB).toString();
  });
}
tabHooks.dash={
  enter:function(){statusPoller.start();pollInfo().catch(function(){})},
  leave:function(){statusPoller.stop()},
  status:dashStatus,
};

/* ============================================================
 * ports tab
 * ============================================================ */
var SPEEDS=[["auto","Auto"],["2g5","2.5G"],["1g","1G"],["100m full","100M full"],
  ["100m half","100M half"],["10m full","10M full"],["10m half","10M half"]];
var SFPRATES=[["auto","Auto"],["10g","10G"],["2g5","2.5G"],["1g","1G"],["100m","100M"]];
function buildPorts(){
  var tb=$("ptable").tBodies[0];
  if(tb.rows.length||!S.n)return;
  S.ports.forEach(function(p){
    var i=p.portNum-1;
    var spd=h("select",{class:"in",id:"pspd"+i});
    (p.isSFP?SFPRATES:SPEEDS).forEach(function(o){
      spd.appendChild(h("option",{value:o[0],text:o[1]}));
    });
    var tr=tb.insertRow();
    tr.insertCell().textContent=p.portNum+(p.isSFP?" (SFP)":"");
    tr.insertCell().appendChild(h("input",{class:"in",id:"pname"+i,size:"9",maxlength:"15",value:p.name||"",placeholder:"—"}));
    tr.insertCell().id="plink"+i;
    tr.insertCell().appendChild(spd);
    var sw=h("span",{class:"switch"},[h("input",{type:"checkbox",id:"pen"+i}),h("i")]);
    sw.firstChild.checked=!!p.enabled;
    tr.insertCell().appendChild(sw);
    tr.insertCell().appendChild(h("input",{class:"in sm",id:"pmtu"+i,type:"number",min:"594",max:"16383"}));
    tr.insertCell().appendChild(h("button",{class:"ctl",text:"Apply",onclick:function(){applyPort(i)}}));
  });
  loadMtu();
}
function loadMtu(){
  return getJSON("/mtu.json").then(function(s){
    s.forEach(function(m){
      S.mtu[m.portNum-1]=parseInt(m.mtu,16);
      var el=$("pmtu"+(m.portNum-1));
      if(el&&document.activeElement!==el)el.value=parseInt(m.mtu,16);
    });
  });
}
function portsStatus(){
  buildPorts();
  S.ports.forEach(function(p){
    var i=p.portNum-1,el=$("plink"+i);
    if(el)el.innerHTML=!p.enabled?'<span class="badge">off</span>'
      :(p.link>0?'<span class="badge ok">'+LINKS[p.link]+"</span>":'<span class="badge">down</span>');
  });
}
function applyPort(i){
  var p=S.ports[i],cmds=[];
  var name=$("pname"+i).value.trim();
  var en=$("pen"+i).checked;
  var spd=$("pspd"+i).value;
  var mtu=parseInt($("pmtu"+i).value,10);
  if(name&&name!==(p.name||"")){
    if(!/^\S{1,15}$/.test(name)){toast("Port name: 1–15 chars, no spaces","err");return;}
    cmds.push("port "+p.portNum+" name "+name);
  }
  if(!en)cmds.push("port "+p.portNum+" off");
  else if(p.isSFP){
    if(!p.enabled)cmds.push("port "+p.portNum+" on");
    cmds.push("sfp "+S.sfpSlot[i]+" "+spd);
  }else cmds.push("port "+p.portNum+" "+spd);
  if(mtu&&mtu!==S.mtu[i]){
    if(mtu<594||mtu>16383){toast("MTU must be 594–16383","err");return;}
    cmds.push("mtu "+p.portNum+" "+mtu);
  }
  postCmds(cmds).then(loadMtu).catch(function(){});
}
tabHooks.ports={
  enter:function(){statusPoller.start();buildPorts()},
  leave:function(){statusPoller.stop()},
  status:portsStatus,
};

/* ============================================================
 * statistics tab
 * ============================================================ */
var MIB=[
  "Interface in Octets",8,"",0,"Interface out Octets",8,"",0,
  "Interface in Unicast Pkts",8,"",0,"Interface in Multicast Pkts",8,"",0,
  "Interface in Broadcast Pkts",8,"",0,"Interface out Unicast Pkts",8,"",0,
  "Interface out Multicast Pkts",8,"",0,"Interface out Broadcast Pkts",8,"",0,
  "Interface out discards",4,"802.1d Tp Port in discards",4,
  "802.3 Single collision frames",4,"802.3 Multi collision frames",4,
  "802.3 Deferred transmissions",4,"802.3 Late collisions",4,
  "802.3 Excessive collisions",4,"802.3 Symbol errors",4,
  "802.3 Control in unknown opcodes",4,"802.3 In Pause frames",4,
  "802.3 Out Pause frames",4,"Ether drop events",4,
  "TX Ether Broadcast Pkts",4,"TX Ether Multicast Pkts",4,
  "TX Ether CRC Align errors",4,"RX Ether CRC Align errors",4,
  "TX Ether Undersized Pkts",4,"RX Ether Undersized Pkts",4,
  "TX Ether Oversized Pkts",4,"RX Ether Oversized Pkts",4,
  "TX Ether Fragments",4,"RX Ether fragments",4,
  "TX Ether Jabbers",4,"RX Ether Jabbers",4,
  "TX Ether Collisions",4,"TX Ether Pkts 64 Octets",4,"RX Ether Pkts 64 Octets",4,
  "TX Ether 65-127 Octets",4,"RX Ether 65-127 Octets",4,
  "TX Ether Pkts 128-255 Octets",4,"RX Ether Pkts 128-255 Octets",4,
  "TX Ether Pkts 256-511 Octets",4,"RX Ether Pkts 256-511 Octets",4,
  "TX Ether Pkts 512-1023 Octets",4,"RX Ether Pkts 512-1023 Octets",4,
  "TX Ether Pkts 1024-1518 Octets",4,"RX Ether Pkts 1024-1518 Octets",4,
  "",4,"RX Ether Undersized Drop Pkts",4,
  "TX Ether Pkts >1518 Octets",4,"RX Ether Pkts >1518 Octets",4,
  "TX Ether Pkts too large",4,"RX Ether Pkts too large",4,
  "TX Ether Flexible Octets Set 1",4,"RX Ether Flexible Octets Set 1",4,
  "TX Ether Flexible Octets CRC Set 1",4,"RX Ether Flexible Octets CRC Set 1",4,
  "TX Ether Flexible Octets Set 0",4,"RX Ether Flexible Octets Set 0",4,
  "TX Ether Flexible Octets CRC Set 0",4,"RX Ether Flexible Octets CRC Set 0",4,
  "Length Field Errors",4,"False Carriers",4,"Undersized Octets",4,"Framing Errors",4,
  "",4,"RX MAC Discards",4,"RX MAC IPG Short Drop",4,"",4,
  "802.1d TP Learned Entry Discards",4,
  "Egress Queue 7 Dropped Pkts",4,"Egress Queue 6 Dropped Pkts",4,
  "Egress Queue 5 Dropped Pkts",4,"Egress Queue 4 Dropped Pkts",4,
  "Egress Queue 3 Dropped Pkts",4,"Egress Queue 2 Dropped Pkts",4,
  "Egress Queue 1 Dropped Pkts",4,"Egress Queue 0 Dropped Pkts",4,
  "Egress Queue 7 Out Pkts",4,"Egress Queue 6 Out Pkts",4,
  "Egress Queue 5 Out Pkts",4,"Egress Queue 4 Out Pkts",4,
  "Egress Queue 3 Out Pkts",4,"Egress Queue 2 Out Pkts",4,
  "Egress Queue 1 Out Pkts",4,"Egress Queue 0 Out Pkts",4,
  "TX Good Counter",8,"",0,"RX Good Counter",8,"",0,
  "RX Error Counter",4,"TX Error Counter",4,
  "TX Good Counter PHY",8,"",0,"RX Good Counter PHY",8,"",0,
  "RX Error Counter PHY",4,"TX Error Counter PHY",4,
];
/* counters.json returns 64-bit hex words; two 32-bit counters share one word */
function decodeCounters(s){
  var out=[];
  for(var i=0;i<MIB.length;i+=4){
    if(MIB[i]===""&&MIB[i+1]===8)continue;
    var w=BigInt(s[i/4]||"0x0");
    if(MIB[i+1]===8)out.push([MIB[i],w]);
    else{
      if(MIB[i]!=="")out.push([MIB[i],w>>32n]);
      if(MIB[i+2]!=="")out.push([MIB[i+2],w&4294967295n]);
    }
  }
  return out;
}
var ctrPoll=null;
function showCounters(i){
  var body=h("div");
  var bar=h("div",{style:"display:flex;gap:12px;align-items:center;margin-bottom:10px"});
  var nz=h("input",{type:"checkbox",id:"ctr-nz",checked:""});
  var auto=h("input",{type:"checkbox",id:"ctr-auto"});
  bar.appendChild(h("label",null,[nz,document.createTextNode(" non-zero only")]));
  bar.appendChild(h("label",null,[auto,document.createTextNode(" auto-refresh")]));
  var wrap=h("div",{class:"scrollx"});
  body.appendChild(bar);body.appendChild(wrap);
  function load(){
    return getJSON("/counters.json?port="+S.physToLog[i]).then(function(s){
      var rows=decodeCounters(s);
      var t=h("table",{class:"t"});
      t.appendChild(h("tr",null,[h("th",{text:"Counter"}),h("th",{class:"num",text:"Value"})]));
      rows.forEach(function(r){
        if(nz.checked&&r[1]===0n)return;
        t.appendChild(h("tr",null,[h("td",{text:r[0]}),h("td",{class:"num mono",text:r[1].toString()})]));
      });
      wrap.innerHTML="";wrap.appendChild(t);
    });
  }
  nz.addEventListener("change",load);
  if(ctrPoll)ctrPoll.stop();
  ctrPoll=new Poller(function(){return auto.checked?load():Promise.resolve()},2500);
  ctrPoll.start();
  load().catch(function(){wrap.textContent="failed to load counters"});
  modal("Port "+(i+1)+" — MIB counters",body,
    [h("button",{class:"ctl",text:"Refresh",onclick:function(){load()}}),
     h("button",{class:"ctl pri",text:"Close",onclick:function(){ctrPoll.stop();closeModal()}})]);
}
function statsStatus(){
  var tb=$("stable").tBodies[0];
  if(tb.rows.length!==S.n){
    tb.innerHTML="";
    for(var i=0;i<S.n;i++)(function(i){
      var tr=tb.insertRow();
      for(var c=0;c<7;c++)tr.insertCell().className=c>=3?"num":"";
      tr.insertCell().appendChild(h("button",{class:"ctl",text:"Details",onclick:function(){showCounters(i)}}));
    })(i);
  }
  S.ports.forEach(function(p){
    var r=tb.rows[p.portNum-1];
    if(!r)return;
    r.cells[0].textContent=p.portNum;
    r.cells[1].textContent=p.name||"";
    r.cells[2].innerHTML=!p.enabled?'<span class="badge">off</span>'
      :(p.link>0?'<span class="badge ok">'+LINKS[p.link]+"</span>":'<span class="badge">down</span>');
    r.cells[3].textContent=BigInt(p.txG).toString();
    r.cells[4].textContent=BigInt(p.txB).toString();
    r.cells[5].textContent=BigInt(p.rxG).toString();
    r.cells[6].textContent=BigInt(p.rxB).toString();
  });
}
tabHooks.stats={
  enter:function(){statusPoller.start()},
  leave:function(){statusPoller.stop();if(ctrPoll)ctrPoll.stop()},
  status:statsStatus,
};

/* ============================================================
 * VLAN tab
 * ============================================================ */
function maskToPorts(mask){
  var out=[];
  for(var p=1;p<=S.n;p++)if((mask>>S.physToLog[p-1])&1)out.push(p);
  return out;
}
function rangeStr(list){
  if(!list.length)return"–";
  var parts=[],s=list[0],e=list[0];
  for(var i=1;i<=list.length;i++){
    if(list[i]===e+1){e=list[i];continue}
    parts.push(s===e?String(s):s+"-"+e);
    s=e=list[i];
  }
  return parts.join(", ");
}
function vlanRefresh(){
  var tb=$("vtable").tBodies[0];
  return getJSON("/vlanlist").then(function(vl){
    $("vempty").style.display=vl.length?"none":"";
    tb.innerHTML="";
    var p=Promise.resolve();
    vl.forEach(function(v){
      p=p.then(function(){return getJSON("/vlan.json?vid="+v.id)}).then(function(d){
        var m=parseInt(d.members,16),mem=m&0x3ff,unt=((m>>10)&0x3ff)&mem;
        var pv=parseInt(d.pvid,16)&0x3ff;
        var tr=tb.insertRow();
        tr.insertCell().appendChild(h("a",{href:"#vlan",text:String(v.id),onclick:function(e){
          e.preventDefault();$("vvid").value=v.id;vlanLoad();
        }}));
        tr.insertCell().textContent=v.name||"";
        tr.insertCell().textContent=rangeStr(maskToPorts(mem));
        tr.insertCell().textContent=rangeStr(maskToPorts(mem&~unt));
        tr.insertCell().textContent=rangeStr(maskToPorts(unt));
        tr.insertCell().textContent=rangeStr(maskToPorts(pv));
        var del=tr.insertCell();
        if(v.id!==1)del.appendChild(h("button",{class:"ctl",text:"✕",title:"Delete VLAN",onclick:function(){
          confirmModal("Delete VLAN "+v.id+"?","Ports keep their PVID until reassigned.",function(){
            postCmd("vlan "+v.id+" d").then(vlanRefresh).catch(function(){});
          });
        }}));
      }).catch(function(){});
    });
    return p;
  });
}
/* editor: per-port tri-state (– / U / T) + PVID checkboxes */
function buildVlanEdit(){
  var tb=$("vedit").tBodies[0];
  if(tb.rows.length||!S.n)return;
  var hd=tb.insertRow();hd.insertCell().className="mut";
  var rM=tb.insertRow();rM.insertCell().textContent="Member";
  var rP=tb.insertRow();rP.insertCell().textContent="PVID";
  for(var p=1;p<=S.n;p++)(function(p){
    hd.insertCell().innerHTML='<b>'+p+'</b>';
    var seg=h("span",{class:"seg",id:"vm"+p});
    ["–","U","T"].forEach(function(s,ix){
      seg.appendChild(h("button",{text:s,"data-v":ix,onclick:function(){
        seg.querySelectorAll("button").forEach(function(b){b.classList.remove("on")});
        this.classList.add("on");
      }}));
    });
    seg.children[0].classList.add("on");
    rM.insertCell().appendChild(seg);
    rP.insertCell().appendChild(h("input",{type:"checkbox",id:"vp"+p}));
  })(p);
  /* ingress table */
  var it=$("ingress").tBodies[0];
  var ih=it.insertRow();ih.insertCell().className="mut";
  var ir=it.insertRow();ir.insertCell().textContent="Accept";
  for(var q=1;q<=S.n;q++)(function(q){
    ih.insertCell().innerHTML='<b>'+q+'</b>';
    var sel=h("select",{class:"in",id:"ing"+q});
    [["","—"],["a","All"],["u","Untagged"],["t","Tagged"]].forEach(function(o){
      sel.appendChild(h("option",{value:o[0],text:o[1]}));
    });
    ir.insertCell().appendChild(sel);
  })(q);
}
function segVal(p){
  var seg=$("vm"+p);
  return Number(seg.querySelector("button.on").getAttribute("data-v"));
}
function segSet(p,v){
  var seg=$("vm"+p);
  seg.querySelectorAll("button").forEach(function(b,i){b.classList.toggle("on",i===v)});
}
function vlanLoad(){
  var vid=parseInt($("vvid").value,10);
  if(!vid||vid<1||vid>4094){toast("Enter a VLAN ID (1–4094)","err");return;}
  getJSON("/vlan.json?vid="+vid).then(function(d){
    $("vname").value=d.name||"";
    var m=parseInt(d.members,16),mem=m&0x3ff,unt=((m>>10)&0x3ff)&mem;
    var pv=parseInt(d.pvid,16)&0x3ff;
    for(var p=1;p<=S.n;p++){
      var bit=S.physToLog[p-1];
      segSet(p,(mem>>bit)&1?(((unt>>bit)&1)?1:2):0);
      $("vp"+p).checked=!!((pv>>bit)&1);
    }
    toast("Loaded VLAN "+vid,"ok");
  }).catch(function(){toast("VLAN "+vid+" not found (a new one can still be created)","err")});
}
function vlanApply(){
  var vid=parseInt($("vvid").value,10);
  if(!vid||vid<1||vid>4094){toast("Enter a VLAN ID (1–4094)","err");return;}
  var name=$("vname").value.trim();
  if(name&&!/^[a-zA-Z]\w*$/.test(name)){toast("Name must start with a letter (letters/digits/_)","err");return;}
  var cmd="vlan "+vid+(name?" "+name:""),members=0;
  for(var p=1;p<=S.n;p++){
    var v=segVal(p);
    if(v===1){cmd+=" "+p;members++;}       /* untagged member */
    else if(v===2){cmd+=" "+p+"t";members++;} /* tagged member */
  }
  if(!members){toast("Select at least one member port (or delete the VLAN instead)","err");return;}
  var cmds=[cmd];
  for(var q=1;q<=S.n;q++)if($("vp"+q).checked)cmds.push("pvid "+q+" "+vid);
  postCmds(cmds).then(vlanRefresh).catch(function(){});
}
function ingressApply(){
  var cmd="ingress",any=false;
  for(var p=1;p<=S.n;p++){
    var v=$("ing"+p).value;
    if(v){cmd+=" "+p+v;any=true;}
  }
  if(!any){toast("Pick an ingress mode for at least one port","err");return;}
  postCmd(cmd).catch(function(){});
}
$("vload").addEventListener("click",vlanLoad);
$("vapply").addEventListener("click",vlanApply);
$("ingapply").addEventListener("click",ingressApply);
$("vmgmt").addEventListener("click",function(){
  var vid=parseInt($("vvid").value,10);
  if(!vid){toast("Enter a VLAN ID first","err");return;}
  confirmModal("Set VLAN "+vid+" as management VLAN?",
    "Management access moves to this VLAN. A wrong VLAN can lock you out of the web UI (recover via serial console or reset button).",
    function(){postCmd("vlan "+vid+" mgmt").catch(function(){})});
});
tabHooks.vlan={
  enter:function(){needPorts(function(){buildVlanEdit();vlanRefresh().catch(function(){})})},
};

/* ============================================================
 * MAC table (L2)
 * ============================================================ */
var l2Rows=[];
function l2Fetch(){
  $("l2count").textContent="loading…";
  var seen={},all=[],idx=0,guard=0;
  function step(){
    return getJSON("/l2.json?idx="+idx).then(function(s){
      if(!s.length)return finish();
      var wrapped=false;
      s.forEach(function(e){
        e.idx=parseInt(e.idx,16);
        if(seen[e.idx]){wrapped=true;return;}
        seen[e.idx]=1;
        e.vlan=parseInt(e.vlan,16);
        e.type=e.type==="s"?"static":"learned";
        e.pport=e.port===9?"CPU":S.logToPhys[e.port];
        all.push(e);
      });
      if(wrapped||++guard>140)return finish();
      idx=s[s.length-1].idx+1;
      return step();
    });
  }
  function finish(){
    all.sort(function(a,b){
      return(a.pport>b.pport)-(a.pport<b.pport)||(a.mac>b.mac)-(a.mac<b.mac);
    });
    l2Rows=all;
    l2Render();
  }
  return step().catch(function(){$("l2count").textContent="load failed"});
}
function l2Render(){
  var f=$("l2filter").value.toLowerCase();
  var tb=$("l2table").tBodies[0];tb.innerHTML="";
  var shown=0;
  l2Rows.forEach(function(e){
    var hay=(e.mac+" "+e.vlan+" "+e.pport+" "+e.type).toLowerCase();
    if(f&&hay.indexOf(f)<0)return;
    shown++;
    var tr=tb.insertRow();
    tr.insertCell().textContent=e.pport;
    tr.insertCell().className="mono";tr.cells[1].textContent=e.mac;
    tr.insertCell().textContent=e.vlan;
    tr.insertCell().textContent=e.type;
    tr.insertCell().appendChild(h("button",{class:"ctl",text:"✕",title:"Delete entry",onclick:function(){
      getJSON("/l2_del.json?idx="+e.idx).then(function(){l2Fetch()}).catch(function(){});
    }}));
  });
  $("l2count").textContent=shown+" / "+l2Rows.length+" entries";
}
$("l2filter").addEventListener("input",l2Render);
$("l2refresh").addEventListener("click",function(){l2Fetch()});
$("l2flush").addEventListener("click",function(){
  confirmModal("Flush all learned MAC entries?","",function(){
    postCmd("l2 forget").then(function(){setTimeout(l2Fetch,500)}).catch(function(){});
  });
});
tabHooks.l2={enter:function(){needPorts(function(){l2Fetch()})}};

/* wait until port count is known (one status fetch if needed) */
function needPorts(fn){
  if(S.n)return fn();
  pollStatus().then(fn).catch(function(){});
}
function confirmModal(title,detail,onok){
  var b=h("div");
  if(detail)b.appendChild(h("p",{class:"small",text:detail}));
  modal(title,b,[
    h("button",{class:"ctl",text:"Cancel",onclick:closeModal}),
    h("button",{class:"ctl pri",text:"Confirm",onclick:function(){closeModal();onok()}}),
  ]);
}

/* ============================================================
 * mirroring
 * ============================================================ */
function buildMirror(){
  var sel=$("mport");
  if(sel.options.length)return;
  for(var p=1;p<=S.n;p++)sel.appendChild(h("option",{value:p,text:"Port "+p}));
  var tb=$("mtable").tBodies[0];
  var hd=tb.insertRow();hd.insertCell().className="mut";
  var r=tb.insertRow();r.insertCell().textContent="Mirror";
  for(var q=1;q<=S.n;q++)(function(q){
    hd.insertCell().innerHTML="<b>"+q+"</b>";
    var seg=h("span",{class:"seg",id:"mm"+q});
    ["–","RX","TX","Both"].forEach(function(s,ix){
      seg.appendChild(h("button",{text:s,"data-v":ix,onclick:function(){
        seg.querySelectorAll("button").forEach(function(b){b.classList.remove("on")});
        this.classList.add("on");
      }}));
    });
    seg.children[0].classList.add("on");
    r.insertCell().appendChild(seg);
  })(q);
}
function mirrorLoad(){
  return getJSON("/mirror.json").then(function(m){
    $("mstate").textContent=m.enabled?"active":"off";
    $("mstate").className="badge "+(m.enabled?"ok":"");
    if(m.enabled)$("mport").value=m.mPort;
    var tx=parseInt(m.mirror_tx,2),rx=parseInt(m.mirror_rx,2);
    for(var p=1;p<=S.n;p++){
      var bit=S.physToLog[p-1];
      var v=(((rx>>bit)&1)?1:0)+(((tx>>bit)&1)?2:0);
      var seg=$("mm"+p);
      seg.querySelectorAll("button").forEach(function(b,i){b.classList.toggle("on",i===v)});
    }
  });
}
$("mapply").addEventListener("click",function(){
  var mp=$("mport").value,cmd="mirror "+mp,any=false;
  for(var p=1;p<=S.n;p++){
    if(String(p)===mp)continue;
    var v=Number($("mm"+p).querySelector("button.on").getAttribute("data-v"));
    if(v===1){cmd+=" "+p+"r";any=true;}
    else if(v===2){cmd+=" "+p+"t";any=true;}
    else if(v===3){cmd+=" "+p;any=true;}
  }
  if(!any){toast("Select at least one mirrored port","err");return;}
  postCmd(cmd).then(mirrorLoad).catch(function(){});
});
$("moff").addEventListener("click",function(){
  postCmd("mirror off").then(mirrorLoad).catch(function(){});
});
tabHooks.mirror={enter:function(){needPorts(function(){buildMirror();mirrorLoad().catch(function(){})})}};

/* ============================================================
 * LAG
 * ============================================================ */
var HASHF=["spa","smac","dmac","sip","dip","sport","dport"];
function buildLag(){
  var w=$("lagwrap");
  if(w.children.length)return;
  for(var g=0;g<4;g++)(function(g){
    var card=h("div",{class:"card"});
    card.appendChild(h("h2",{text:"LAG "+g}));
    var pr=h("div",{style:"display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px"});
    for(var p=1;p<=S.n;p++)pr.appendChild(h("label",null,[
      h("input",{type:"checkbox",id:"lg"+g+"p"+p}),document.createTextNode(" "+p+" "),
    ]));
    card.appendChild(pr);
    var hr=h("div",{style:"display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px",class:"small"});
    hr.appendChild(h("span",{class:"mut",text:"Hash:"}));
    HASHF.forEach(function(f){
      hr.appendChild(h("label",null,[h("input",{type:"checkbox",id:"lg"+g+"h"+f}),document.createTextNode(" "+f+" ")]));
    });
    card.appendChild(hr);
    card.appendChild(h("button",{class:"ctl pri",text:"Apply",onclick:function(){lagApply(g)}}));
    w.appendChild(card);
  })(g);
}
function lagLoad(){
  return getJSON("/lag.json").then(function(s){
    for(var g=0;g<4;g++){
      var members=parseInt(s[g].members,2);
      for(var p=1;p<=S.n;p++)
        $("lg"+g+"p"+p).checked=!!((members>>S.physToLog[p-1])&1);
      var hash=parseInt(s[g].hash,16);
      HASHF.forEach(function(f,i){$("lg"+g+"h"+f).checked=!!((hash>>i)&1)});
    }
  });
}
function lagApply(g){
  var cmd="lag "+g,n=0;
  for(var p=1;p<=S.n;p++)if($("lg"+g+"p"+p).checked){cmd+=" "+p;n++;}
  if(!n){toast("Select at least one member (clearing a LAG isn't supported by the CLI grammar)","err");return;}
  var hcmd="laghash "+g,nh=0;
  HASHF.forEach(function(f){if($("lg"+g+"h"+f).checked){hcmd+=" "+f;nh++;}});
  var cmds=[cmd];
  if(nh)cmds.push(hcmd);
  postCmds(cmds).then(lagLoad).catch(function(){});
}
tabHooks.lag={enter:function(){needPorts(function(){buildLag();lagLoad().catch(function(){})})}};

/* ============================================================
 * EEE
 * ============================================================ */
function eeeFlags(bits){
  var b=parseInt(bits,2);
  return["100M","1G","2.5G"].map(function(s,i){
    return(b&(4>>i))?s:null;
  }).filter(Boolean).join(" · ")||"–";
}
function eeeLoad(){
  return getJSON("/eee.json").then(function(s){
    var tb=$("etable").tBodies[0];tb.innerHTML="";
    s.forEach(function(p){
      var tr=tb.insertRow();
      tr.insertCell().textContent=p.portNum+(p.isSFP?" (SFP)":"");
      if(p.isSFP){
        for(var c=0;c<3;c++)tr.insertCell().textContent="–";
        tr.insertCell().textContent="n/a";
        return;
      }
      tr.insertCell().textContent=eeeFlags(p.eee);
      tr.insertCell().textContent=eeeFlags(p.eee_lp);
      tr.insertCell().innerHTML=p.active?'<span class="badge ok">active</span>':'<span class="badge">idle</span>';
      var on=parseInt(p.eee,2)!==0;
      var sw=h("span",{class:"switch"},[
        h("input",{type:"checkbox",onchange:function(){
          postCmd("eee "+p.portNum+" "+(this.checked?"on":"off"))
            .then(function(){setTimeout(eeeLoad,300)}).catch(function(){});
        }}),h("i")]);
      sw.firstChild.checked=on;
      tr.insertCell().appendChild(sw);
    });
  });
}
var eeePoller=new Poller(function(){return eeeLoad()},4000);
tabHooks.eee={enter:function(){eeePoller.start()},leave:function(){eeePoller.stop()}};

/* ============================================================
 * bandwidth — hardware unit is 16 kbit/s per register step
 * ============================================================ */
function bwLoad(){
  return getJSON("/bandwidth.json").then(function(s){
    var tb=$("btable").tBodies[0];tb.innerHTML="";
    s.forEach(function(p){
      var n=p.portNum;
      var iOn=!!Number(p.iLimited),eOn=!!Number(p.eLimited);
      var iM=(parseInt(p.iBW,16)*16/1000),eM=(parseInt(p.eBW,16)*16/1000);
      var tr=tb.insertRow();
      tr.insertCell().textContent=n;
      var icb=h("input",{type:"checkbox",id:"bwi"+n});icb.checked=iOn;
      tr.insertCell().appendChild(icb);
      var iin=h("input",{class:"in sm",id:"bwiv"+n,type:"number",min:"0.016",max:"1048",step:"any"});
      if(iOn)iin.value=+iM.toFixed(3);
      tr.insertCell().appendChild(iin);
      var msel=h("select",{class:"in",id:"bwm"+n},[
        h("option",{value:"fc",text:"Flow control"}),
        h("option",{value:"drop",text:"Drop"}),
      ]);
      msel.value=Number(p.iFC)===1?"fc":"drop";
      tr.insertCell().appendChild(msel);
      var ecb=h("input",{type:"checkbox",id:"bwe"+n});ecb.checked=eOn;
      tr.insertCell().appendChild(ecb);
      var ein=h("input",{class:"in sm",id:"bwev"+n,type:"number",min:"0.016",max:"1048",step:"any"});
      if(eOn)ein.value=+eM.toFixed(3);
      tr.insertCell().appendChild(ein);
      tr.insertCell().appendChild(h("button",{class:"ctl",text:"Apply",onclick:function(){bwApply(n)}}));
    });
  });
}
function bwHex(mbit){
  var steps=Math.round(mbit*1000/16);
  if(steps<1||steps>0xffff)return null;
  return steps.toString(16).padStart(4,"0");
}
function bwApply(n){
  var cmds=[];
  if($("bwi"+n).checked){
    var ih=bwHex(parseFloat($("bwiv"+n).value));
    if(!ih){toast("Ingress limit must be 0.016–1048 Mbit/s","err");return;}
    cmds.push("bw in "+n+" "+ih);
    cmds.push("bw in "+n+" "+($("bwm"+n).value==="fc"?"fc":"drop"));
  }else cmds.push("bw in "+n+" off");
  if($("bwe"+n).checked){
    var eh=bwHex(parseFloat($("bwev"+n).value));
    if(!eh){toast("Egress limit must be 0.016–1048 Mbit/s","err");return;}
    cmds.push("bw out "+n+" "+eh);
  }else cmds.push("bw out "+n+" off");
  postCmds(cmds).then(bwLoad).catch(function(){});
}
tabHooks.bw={enter:function(){needPorts(function(){bwLoad().catch(function(){})})}};

/* ============================================================
 * system
 * ============================================================ */
var IPRE=/^(\d{1,3}\.){3}\d{1,3}$/;
function okIp(s){
  if(!IPRE.test(s))return false;
  return s.split(".").every(function(o){return+o<=255});
}
function sysLoad(){
  pollInfo().then(function(){
    $("sy-ip").value=S.info.ip_address||"";
    $("sy-mask").value=S.info.ip_netmask||"";
    $("sy-gw").value=S.info.ip_gateway||"";
    if(S.info.hostname!=null)$("sy-host").value=S.info.hostname;
    if(S.info.syslog_server_ip)$("sy-sysip").value=S.info.syslog_server_ip;
  }).catch(function(){});
  cfgReload();
}
/* service toggles reflect the startup config (no runtime read-back) */
function cfgParseKnown(txt){
  S.cfgKnown={stp:false,igmp:false,syslogOn:false,syslogIp:""};
  txt.split(/\r?\n/).forEach(function(l){
    l=l.trim();
    if(/^stp on$/.test(l))S.cfgKnown.stp=true;
    if(/^stp off$/.test(l))S.cfgKnown.stp=false;
    if(/^igmp on$/.test(l))S.cfgKnown.igmp=true;
    if(/^syslog on$/.test(l))S.cfgKnown.syslogOn=true;
    if(/^syslog off$/.test(l))S.cfgKnown.syslogOn=false;
    var m=l.match(/^syslog ip ((\d{1,3}\.){3}\d{1,3})$/);
    if(m)S.cfgKnown.syslogIp=m[1];
  });
  $("sy-stp").checked=S.cfgKnown.stp;
  $("sy-igmp").checked=S.cfgKnown.igmp;
  $("sy-syslog").checked=S.cfgKnown.syslogOn;
  if(S.cfgKnown.syslogIp&&!$("sy-sysip").value)$("sy-sysip").value=S.cfgKnown.syslogIp;
}
$("sy-apply").addEventListener("click",function(){
  var ip=$("sy-ip").value.trim(),mask=$("sy-mask").value.trim(),gw=$("sy-gw").value.trim();
  if(!okIp(ip)||!okIp(mask)||!okIp(gw)){toast("Invalid IP / netmask / gateway","err");return;}
  var cmds=[];
  var hn=$("sy-host").value.trim();
  if($("hostrow").style.display!=="none"&&hn&&hn!==S.info.hostname){
    if(!/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,18}[a-zA-Z0-9])?$/.test(hn)){
      toast("Hostname: 1–20 chars a-z 0-9 '-', no leading/trailing '-'","err");return;
    }
    cmds.push("hostname "+hn);
  }
  cmds.push("ip "+ip,"netmask "+mask,"gw "+gw);
  var changingIp=ip!==S.info.ip_address;
  confirmModal("Apply network settings?",
    changingIp?"The management IP changes to "+ip+" — this page will need to be reopened there.":"",
    function(){
      postCmds(cmds).then(function(){
        if(changingIp)toast("IP changed — reconnect at http://"+ip+"/","ok");
        else sysLoad();
      }).catch(function(){});
    });
});
$("sy-dhcp").addEventListener("click",function(){
  confirmModal("Switch to DHCP?",
    "The switch requests an address via DHCP. You must find its new IP to reconnect.",
    function(){postCmd("ip dhcp").catch(function(){})});
});
$("sy-stp").addEventListener("change",function(){
  postCmd("stp "+(this.checked?"on":"off")).catch(function(){});
});
$("sy-igmp").addEventListener("change",function(){
  var el=this;
  if(!el.checked){
    /* firmware has 'igmp on' but no documented off in config grammar → guard */
    postCmd("igmp off").catch(function(){el.checked=true});
  }else postCmd("igmp on").catch(function(){el.checked=false});
});
$("sy-syslog").addEventListener("change",function(){
  var cmds=[];
  if(this.checked){
    var sip=$("sy-sysip").value.trim();
    if(sip&&!okIp(sip)){toast("Invalid syslog server IP","err");this.checked=false;return;}
    if(sip)cmds.push("syslog ip "+sip);
    cmds.push("syslog on");
  }else cmds.push("syslog off");
  postCmds(cmds).catch(function(){});
});
$("sy-pwapply").addEventListener("click",function(){
  var a=$("sy-pw1").value,b=$("sy-pw2").value;
  if(a.length<1||a.length>20){toast("Password: 1–20 characters","err");return;}
  if(/\s/.test(a)){toast("Password cannot contain spaces","err");return;}
  if(a!==b){toast("Passwords do not match","err");return;}
  confirmModal("Change admin password?","Takes effect immediately for new logins. Save to flash to persist.",function(){
    postCmd("passwd "+a).then(function(){
      $("sy-pw1").value=$("sy-pw2").value="";
    }).catch(function(){});
  });
});
$("sy-send").addEventListener("click",sysConsole);
$("sy-cmd").addEventListener("keydown",function(e){if(e.key==="Enter")sysConsole()});
function sysConsole(){
  var c=$("sy-cmd").value.trim();
  if(!c)return;
  var out=$("sy-cout");
  api("/cmd",{method:"POST",body:c}).then(function(r){
    var body=r.body.replace(/\s+$/,"");
    out.textContent+="> "+c+"\n";
    if(body)out.textContent+=body+"\n";
    else out.textContent+=(r.ok?"OK":"ERROR "+r.status)+"\n";
    out.scrollTop=out.scrollHeight;
    if(r.ok&&isConfCmd(c))setDirty(true);
  }).catch(function(e){out.textContent+="> "+c+"\n"+e+"\n"});
  $("sy-cmd").value="";
}
$("sy-reboot").addEventListener("click",function(){
  confirmModal("Reboot the switch?",
    S.dirty?"There are UNSAVED changes — they will be lost. Save to flash first if you want to keep them.":"",
    function(){
      api("/reset").catch(function(){});
      toast("Rebooting — reconnect in ~20 s","ok");
    });
});
/* startup-config editor */
function cfgReload(){
  return getText("/config").then(function(t){
    t=t.replace(/\0[\s\S]*$/,"");
    $("cfgedit").value=t;
    cfgBytes();
    cfgParseKnown(t);
  }).catch(function(){});
}
function cfgBytes(){
  var n=new Blob([$("cfgedit").value]).size;
  var el=$("cfgbytes");
  el.textContent=n+" / 2048 bytes";
  el.style.color=n>2048?"var(--bad)":"";
  return n;
}
$("cfgedit").addEventListener("input",cfgBytes);
$("cfgreload").addEventListener("click",cfgReload);
$("cfgwrite").addEventListener("click",function(){
  var txt=$("cfgedit").value;
  writeConfig(txt,"Write this startup configuration?");
});
tabHooks.system={enter:sysLoad};

/* ============================================================
 * save-to-flash — merge running changes into the startup config
 * (validated grammar; verified write; cmd_log cleared only after
 *  a successful read-back)
 * ============================================================ */
var CONF_OVERWRITE=[
  /^ip\b/,/^gw\b/,/^netmask\b/,/^hostname\b/,/^syslog\s+ip\b/,/^syslog\b/,/^passwd\b/,
  /^vlan\s+\d{1,4}\s+mgmt$/,/^vlan\s+\d{1,4}(?!\s+mgmt\b)/,
  /^pvid\s+\d{1,2}\b/,/^ingress\b/,
  /^port\s+\d{1,2}(?!\s+name\b)/,/^port\s+\d{1,2}\s+name\b/,
  /^eee\s+\d{1,2}\b/,/^eee\b/,/^mirror\b/,
  /^lag\s+\d+\b/,/^laghash\b/,/^isolate\s+\d{1,2}\b/,
  /^stp\b/,/^igmp\b/,/^mtu\s+\d{1,2}\b/,/^bw\s+(in|out)\s+\d{1,2}\b/,
];
function mergeConf(base,texts){
  var conf=base.slice();
  texts.forEach(function(t){
    t.split(/\r?\n/).forEach(function(line){
      line=line.trim().replace(/\s+/g," ");
      if(!line)return;
      var del=line.match(/^vlan\s+(\d{1,4})\s+d$/);
      if(del){
        var pre="vlan "+del[1]+" ";
        conf=conf.filter(function(c){return c.indexOf(pre)!==0});
        return;
      }
      if(!isConfCmd(line))return;
      for(var i=0;i<CONF_OVERWRITE.length;i++){
        var rx=CONF_OVERWRITE[i];
        if(rx.test(line)){
          var key=line.match(rx)[0];
          conf=conf.filter(function(item){
            return!(item===key||(item.indexOf(key+" ")===0
              &&!/\smgmt$/.test(item)&&item.indexOf(key+" name ")!==0));
          });
          break;
        }
      }
      if(/^vlan\s+\d{1,4}\s+mgmt$/.test(line))
        conf=conf.filter(function(c){return!/^vlan\s+\d{1,4}\s+mgmt$/.test(c)});
      conf.push(line);
    });
  });
  return conf;
}
function writeConfig(txt,title){
  txt=txt.replace(/\r\n/g,"\n");
  if(txt&&txt.slice(-1)!=="\n")txt+="\n";
  var bytes=new Blob([txt]).size;
  var lines=txt.split("\n").filter(function(l){return l.trim()});
  var unknown=lines.filter(function(l){return!isConfCmd(l.trim().replace(/\s+/g," "))});
  var body=h("div");
  body.appendChild(h("p",{class:"small mut",text:bytes+" / 2048 bytes · replayed line-by-line on every boot"}));
  if(bytes>2048){
    body.appendChild(h("p",{class:"small",style:"color:var(--bad)",
      text:"Too large — the config sector accepts at most 2048 bytes. Remove lines first."}));
    modal(title,body,[h("button",{class:"ctl",text:"Close",onclick:closeModal})]);
    return;
  }
  if(unknown.length)
    body.appendChild(h("p",{class:"small",style:"color:var(--warn)",
      text:"⚠ Not in the known config grammar (will still be written): "+unknown.join(" · ")}));
  body.appendChild(h("pre",{class:"cfg",text:txt||"(empty)"}));
  modal(title,body,[
    h("button",{class:"ctl",text:"Cancel",onclick:closeModal}),
    h("button",{class:"ctl pri",text:"Write to flash",onclick:function(){
      closeModal();
      doWriteConfig(txt);
    }}),
  ]);
}
function doWriteConfig(txt){
  var form=new FormData();
  form.append("configuration",new Blob([txt],{type:"application/octet-stream"}),"config.txt");
  toast("Writing configuration…");
  /* Older firmware closes the /config connection without any HTTP
   * response (fetch rejects with NetworkError) even though the sector
   * was written — swallow that and let the read-back verify decide. */
  api("/config",{method:"POST",body:form}).catch(function(){return null}).then(function(r){
    if(r&&!r.ok)throw new Error("config write failed: HTTP "+r.status);
    return getText("/config");
  }).then(function(back){
    back=back.replace(/\0[\s\S]*$/,"").replace(/\r\n/g,"\n").trim();
    if(back!==txt.trim())
      throw new Error("Verification failed — flash content differs from what was sent. Command log NOT cleared.");
    return api("/cmd_log_clear").catch(function(){});
  }).then(function(){
    setDirty(false);
    $("cfgedit").value=txt;cfgBytes();
    toast("Startup configuration saved and verified","ok");
  }).catch(function(e){toast(e.message||String(e),"err")});
}
$("saveBtn").addEventListener("click",function(){
  toast("Collecting running changes…");
  Promise.all([
    getText("/config").catch(function(){return""}),
    getText("/cmd_log").catch(function(){return""}),
  ]).then(function(r){
    var cur=r[0].replace(/\0[\s\S]*$/,"");
    var merged=mergeConf([],[cur,r[1].replace(/\0[\s\S]*$/,"")]);
    writeConfig(merged.join("\n"),"Save running configuration to flash?");
  });
});

/* ============================================================
 * firmware update
 * ============================================================ */
var fwBuf=null;
$("fwfile").addEventListener("change",function(){
  var f=this.files[0];
  fwBuf=null;
  $("fwup").disabled=true;
  $("fwinfo").textContent="";
  if(!f)return;
  var info=$("fwinfo");
  info.textContent=f.name+" — "+f.size+" bytes. Checking…";
  f.arrayBuffer().then(function(buf){
    var u=new Uint8Array(buf),msgs=[],fatal=false;
    if(u.length!==524288){msgs.push("size is "+u.length+" — expected 524288 (512 KiB)");fatal=true;}
    /* image = 2-byte LE bank-0 size header (0x00 0x40), then code starting with LJMP */
    if(u[0]!==0x00||u[1]!==0x40||u[2]!==0x02){msgs.push("missing bank header / LJMP magic — not a firmware image");fatal=true;}
    if(!fatal){
      /* CRC16 poly 0xA001 over whole image must leave residual 0xB001 */
      var crc=0;
      for(var i=0;i<u.length;i++){
        crc^=u[i];
        for(var b=0;b<8;b++)crc=(crc&1)?((crc>>>1)^0xA001):(crc>>>1);
      }
      if(crc!==0xB001){msgs.push("CRC16 check failed (residual 0x"+crc.toString(16)+", want 0xb001) — corrupt image");fatal=true;}
    }
    if(fatal){
      info.innerHTML='<span style="color:var(--bad)">✕ '+esc(msgs.join("; "))+"</span>";
      return;
    }
    fwBuf=f;
    info.innerHTML='<span style="color:var(--ok)">✓ valid RTLPlayground image (size, magic and CRC16 OK)</span>';
    $("fwup").disabled=false;
  });
});
$("fwup").addEventListener("click",function(){
  if(!fwBuf)return;
  confirmModal("Upload firmware?",
    "On a good checksum the switch resets itself and applies the image during boot (the startup config is preserved). Do not power it off until it comes back.",
    function(){
      var form=new FormData();
      form.append("uploadedfile",fwBuf,fwBuf.name);
      var xhr=new XMLHttpRequest();
      var prog=$("fwprog"),st=$("fwstat");
      var sent=false,settled=false,t0=Date.now(),pct=0;
      prog.style.display="";prog.value=0;
      $("fwup").disabled=true;
      function settle(fn){
        if(settled)return;
        settled=true;
        clearInterval(tick);
        prog.style.display="none";
        fn();
      }
      /* an XHR shows no browser-level activity (no tab spinner like the
       * old form POST), so animate the status ourselves from the first
       * moment: percent while sending, elapsed seconds throughout */
      var tick=setInterval(function(){
        var s=Math.round((Date.now()-t0)/1000);
        st.textContent=sent
          ?"finishing flash write… "+s+" s"
          :"uploading… "+pct+"% · "+s+" s";
      },500);
      st.textContent="uploading… 0% · 0 s";
      xhr.upload.onprogress=function(e){
        if(e.lengthComputable){pct=Math.round(100*e.loaded/e.total);prog.value=pct;}
      };
      xhr.upload.onload=function(){
        sent=true;
        prog.removeAttribute("value"); /* indeterminate */
      };
      xhr.onload=function(){settle(function(){
        if(xhr.status===200){
          st.textContent="checksum verified — switch is rebooting…";
          fwSettle(st,true);
        }else{
          st.textContent="✕ the switch rejected the image (bad checksum) — nothing was applied";
          $("fwup").disabled=false;
        }
      })};
      xhr.onerror=function(){settle(function(){
        if(!sent){st.textContent="upload failed — connection lost mid-transfer";$("fwup").disabled=false;return;}
        /* no verdict (pre-89d49a6 firmware, or the connection dropped):
         * infer the outcome from whether the switch reboots */
        fwSettle(st,false);
      })};
      xhr.open("POST","/upload");
      xhr.send(form);
    });
});
/* Wait out the reboot by probing. knownGood: the firmware already
 * answered 200, so any early reply just means the reset is still
 * pending — keep polling. Otherwise (no verdict, older firmware) an
 * answer in the first seconds means no reboot happened → rejected.
 * Raw fetch, not api(): a 401 from the fresh boot still counts as
 * "the switch is back". */
function fwSettle(st,knownGood){
  var waited=3,down=false;
  function probe(){
    var ctl=("AbortController"in window)?new AbortController():null;
    var to=setTimeout(function(){if(ctl)ctl.abort()},2500);
    fetch("/information.json",{signal:ctl?ctl.signal:undefined,cache:"no-store"}).then(function(){
      clearTimeout(to);
      if(!down&&waited<=9){
        if(!knownGood){
          st.textContent="✕ no reboot detected — the image was most likely rejected. If updating from old firmware, verify the version in the sidebar after logging in again.";
          $("fwup").disabled=false;
          return;
        }
        waited+=3;setTimeout(probe,3000);  /* reset still pending */
        return;
      }
      st.textContent="update applied ✓";
      modal("Firmware updated",
        h("p",{text:"The switch verified the image and rebooted into it. The session was reset, so you will be asked to log in again."}),
        [h("button",{class:"ctl pri",text:"Go to login",onclick:function(){location.href="/login.html"}})]);
    },function(){
      clearTimeout(to);
      down=true;
      waited+=3;
      st.textContent="switch is rebooting…";
      if(waited>150){
        st.textContent="switch has not come back after 150 s — check power / serial console";
        $("fwup").disabled=false;
        return;
      }
      setTimeout(probe,3000);
    });
  }
  setTimeout(probe,3000);
}
tabHooks.fw={};

/* ============================================================
 * boot
 * ============================================================ */
window.addEventListener("hashchange",function(){
  var id=location.hash.slice(1);
  if(TABS.some(function(t){return t.id===id})&&id!==curTab)showTab(id);
});
(function(){
  var id=location.hash.slice(1);
  if(!TABS.some(function(t){return t.id===id}))id="dash";
  pollInfo().catch(function(){});
  /* detect pending unsaved changes from a previous session */
  getText("/cmd_log").then(function(t){
    t=t.replace(/\0[\s\S]*$/,"").trim();
    if(t&&t.split(/\r?\n/).some(function(l){return isConfCmd(l.trim())}))setDirty(true);
  }).catch(function(){});
  showTab(id);
})();
