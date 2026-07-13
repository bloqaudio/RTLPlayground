/* app2.js — feature modules split out of app.js: a single served asset
 * must stay under 65535 bytes (f_data.len is uint16 in the firmware).
 * Shares all globals with app.js; loaded right after it. */

/* flow control (802.3x) — per-port pause mode via the console endpoint.
 * `fc status <n>` output: "Port XX: auto" | "Port XX: forced: rx-pause
 * [tx-pause]" | "Port XX: forced: off" (XX is the logical port in hex —
 * ignored; we query per user-port so the label doesn't matter). */
var FCMODES=[["auto","Auto"],["on","On (obey pause)"],["off","Off (ignore pause)"]];
function fcParse(body){
  if(body.indexOf("SFP")>=0)return null;
  if(/\bauto\b/.test(body))return"auto";
  if(/rx-pause/.test(body))return/tx-pause/.test(body)?"gen":"on";
  if(/forced:\s*off/.test(body))return"off";
  return null;
}
function fcQuery(n){
  return api("/cmd",{method:"POST",body:"fc status "+n}).then(function(r){
    if(!r.ok)throw new Error("fc status "+n+" failed");
    return fcParse(r.body);
  });
}
function fcShow(i,m){
  var el=$("fccur"+i);
  if(el)el.innerHTML=m==="auto"?'<span class="badge ok">auto</span>'
    :m==="on"?'<span class="badge">forced: obey</span>'
    :m==="gen"?'<span class="badge">forced: obey+generate</span>'
    :m==="off"?'<span class="badge">forced: off</span>'
    :'<span class="badge">?</span>';
  var sel=$("fcm"+i);
  if(sel&&m&&m!=="gen"&&document.activeElement!==sel)sel.value=m;
}
function fcRefresh(port){
  S.ports.forEach(function(p){
    if(p.isSFP||p.portNum>9)return;
    if(port&&p.portNum!==port)return;
    var i=p.portNum-1;
    fcQuery(p.portNum).then(function(m){fcShow(i,m)}).catch(function(){});
  });
}
function buildFc(){
  var tb=$("fctable").tBodies[0];
  if(tb.rows.length||!S.n)return;
  S.ports.forEach(function(p){
    if(p.isSFP||p.portNum>9)return;
    var i=p.portNum-1;
    var sel=h("select",{class:"in",id:"fcm"+i});
    FCMODES.forEach(function(o){sel.appendChild(h("option",{value:o[0],text:o[1]}))});
    var tr=tb.insertRow();
    tr.insertCell().textContent=portLabel(p);
    tr.insertCell().id="fccur"+i;
    tr.insertCell().appendChild(sel);
    tr.insertCell().appendChild(h("button",{class:"ctl",text:"Apply",onclick:function(){applyFc(p.portNum)}}));
  });
  fcRefresh();
}
function applyFc(n){
  var mode=$("fcm"+(n-1)).value;
  confirmModal("Set flow control to "+mode+" on port "+n+"?",
    "The port link bounces for ~5 s and renegotiates speed; the command returns when done.",
    function(){
      toast("fc "+mode+" "+n+" — port is bouncing, ~6 s…");
      postCmd("fc "+mode+" "+n).then(function(){fcRefresh(n)}).catch(function(){});
    });
}
/* connected-device column: MACs the switch has learned on each port */
function portsMacs(){
  l2Load().then(function(all){
    var by={};
    all.forEach(function(e){
      if(e.pport==="CPU")return;
      (by[e.pport]=by[e.pport]||[]).push(e.mac);
    });
    S.ports.forEach(function(p){
      var el=$("pmac"+(p.portNum-1));
      if(!el)return;
      var m=by[p.portNum]||[];
      /* only a single learned MAC is reliably the attached device;
       * several means a switch/AP behind the port — don't imply one
       * arbitrary MAC is "the" device, just count them */
      el.textContent=!m.length?"—":(m.length===1?m[0]:m.length+" devices");
      el.title=m.join("\n");
    });
  }).catch(function(){});
}
/* flow-control tab: the status poller supplies S.ports; buildFc no-ops
 * once the table exists, so the per-port fc queries fire only once */
tabHooks.fc={
  enter:function(){statusPoller.start();buildFc()},
  leave:function(){statusPoller.stop()},
  status:buildFc,
};

/* ============================================================
 * spanning tree (RSTP) — driven via the console endpoint
 * ============================================================ */
var STP_ROLE={"-":"—","R":"Root","D":"Designated","A":"Alternate","B":"Backup"};
var STP_STATE={"d":"discarding","l":"learning","F":"forwarding"};
function stpQuery(){
  return api("/cmd",{method:"POST",body:"stp status"}).then(function(r){
    if(!r.ok)throw new Error("stp status failed");
    return r.body;
  });
}
function stpParse(body){
  var st={on:true,bridge:"",root:"",via:"",ports:{}};
  if(/^Disabled/.test(body)){st.on=false;return st;}
  body.split("\n").forEach(function(l){
    var m;
    if((m=l.match(/^Bridge ([0-9a-f]{4}\.[0-9a-f]{12})/)))st.bridge=m[1];
    else if((m=l.match(/^Root {3}([0-9a-f]{4}\.[0-9a-f]{12})(.*)$/))){
      st.root=m[1];
      var v=m[2].match(/via port 0?(\d+)/);
      st.via=v?v[1]:"";
    }else if((m=l.match(/^Port 0?([1-9]): (down|([-RDAB]) ([dlF])( edge)?( stp-peer)?)/))){
      st.ports[m[1]]=m[2]==="down"?{down:true}
        :{role:m[3],state:m[4],edge:!!m[5],compat:!!m[6]};
    }
  });
  return st;
}
function buildStp(){
  var tb=$("stptable").tBodies[0];
  if(tb.rows.length||!S.n)return;
  S.ports.forEach(function(p){
    var i=p.portNum-1;
    var sel=h("select",{class:"in",id:"stpe"+i});
    [["auto","Auto"],["on","On"],["off","Off"]].forEach(function(o){
      sel.appendChild(h("option",{value:o[0],text:o[1]}));
    });
    var tr=tb.insertRow();
    tr.insertCell().textContent=portLabel(p)+(p.isSFP?" (SFP)":"");
    tr.insertCell().id="stpr"+i;
    tr.insertCell().id="stps"+i;
    tr.insertCell().appendChild(sel);
    tr.insertCell().appendChild(h("button",{class:"ctl",text:"Apply",onclick:function(){
      postCmd("stp edge "+p.portNum+" "+$("stpe"+i).value).then(stpLoad).catch(function(){});
    }}));
  });
}
function stpLoad(){
  buildStp();
  return stpQuery().then(function(body){
    var st=stpParse(body);
    var en=$("stpen");
    if(document.activeElement!==en)en.checked=st.on;
    $("stpids").textContent=!st.on?"RSTP is disabled — all ports forward."
      :"Bridge "+st.bridge+(st.root
        ?(" · Root "+st.root+(st.via?" via port "+st.via:" (this bridge)")):"");
    S.ports.forEach(function(p){
      var i=p.portNum-1,pi=st.ports[p.portNum];
      var rc=$("stpr"+i),sc=$("stps"+i);
      if(!rc)return;
      if(!st.on){rc.textContent="—";sc.innerHTML='<span class="badge ok">forwarding</span>';return;}
      if(!pi||pi.down){rc.textContent="—";sc.innerHTML='<span class="badge">down</span>';return;}
      rc.textContent=STP_ROLE[pi.role]||"?";
      sc.innerHTML='<span class="badge'+(pi.state==="F"?" ok":"")+'">'
        +(STP_STATE[pi.state]||"?")+"</span>"
        +(pi.edge?' <span class="badge">edge</span>':"")
        +(pi.compat?' <span class="badge">stp-peer</span>':"");
    });
  }).catch(function(){});
}
(function(){
  var sel=$("stpprio");
  for(var i=0;i<16;i++)
    sel.appendChild(h("option",{value:String(i),text:i+" ("+(i*4096)+")"}));
  sel.value="8";
})();
$("stpen").addEventListener("change",function(){
  var el=this,want=el.checked;
  el.checked=!want; /* revert; stpLoad syncs the real state after confirm */
  confirmModal((want?"Enable":"Disable")+" spanning tree?",
    want?"Ports briefly stop forwarding while roles are negotiated (edge ports recover in ~3 s)."
        :"All ports go straight to forwarding; loop protection is lost.",
    function(){postCmd("stp "+(want?"on":"off")).then(stpLoad).catch(function(){})});
});
$("stpprioset").addEventListener("click",function(){
  postCmd("stp prio "+$("stpprio").value).then(stpLoad).catch(function(){});
});
var stpPoller=new Poller(stpLoad,4000);
tabHooks.stp={
  enter:function(){needPorts(function(){buildStp();stpPoller.start()})},
  leave:function(){stpPoller.stop()},
};
