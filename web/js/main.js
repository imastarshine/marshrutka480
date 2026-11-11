// Original fixed-step solo loop plus presentation of the authoritative online world.
"use strict";
const game = new Game();
const onlineView = new OnlineView();
const keyMap = { ArrowUp:"up", ArrowDown:"down", ArrowLeft:"left", ArrowRight:"right", KeyW:"up", KeyS:"down", KeyA:"left", KeyD:"right" };
function isTextControl(target) { return target instanceof Element && Boolean(target.closest("input,textarea,select,[contenteditable=true]")); }
function releaseKeys() {
    Object.keys(game.keys).forEach(k=>game.keys[k]=false);
    if(window.app) Object.keys(window.app.keys).forEach(k=>window.app.keys[k]=false);
    document.querySelectorAll(".controls .on").forEach(b=>b.classList.remove("on"));
    window.app?.sendInput(true);
}
window.addEventListener("keydown",e=>{
    if(isTextControl(e.target))return;
    const mode=window.app?.mode||"solo";
    if(mode==="leaders")return;
    // Let Enter/Space activate focused buttons and links instead of hijacking forms.
    if(e.target instanceof Element && e.target.closest("button,a") && ["Enter","Space"].includes(e.code))return;
    if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Space"].includes(e.code))e.preventDefault();
    if(mode==="solo")game.onKey(e.code,true);
    else if(window.app){
        if(keyMap[e.code])window.app.keys[keyMap[e.code]]=true;
        if(!e.repeat && ["Space","KeyH"].includes(e.code))window.app.honk();
        if(!e.repeat && ["Escape","KeyP"].includes(e.code))window.app.stopBus();
    }
});
window.addEventListener("keyup",e=>{
    if(keyMap[e.code]){game.keys[keyMap[e.code]]=false;if(window.app)window.app.keys[keyMap[e.code]]=false;}
    if(!isTextControl(e.target) && (window.app?.mode||"solo")==="solo")game.onKey(e.code,false);
});
window.addEventListener("blur",releaseKeys);
window.addEventListener("pagehide",releaseKeys);
document.addEventListener("visibilitychange",()=>{if(document.hidden)releaseKeys();});
if(matchMedia("(pointer: coarse)").matches || location.search.includes("touch"))document.body.classList.add("touch");
document.querySelectorAll("[data-key]").forEach(btn=>{
    const set=(on)=>(e)=>{
        e.preventDefault();
        if(on){try{btn.setPointerCapture(e.pointerId);}catch(_){/* older browser */}}
        const keys=window.app?.mode==="online"?window.app.keys:game.keys;
        keys[btn.dataset.key]=on;btn.classList.toggle("on",on);
    };
    btn.addEventListener("pointerdown",set(true));
    for(const event of ["pointerup","pointercancel","lostpointercapture"])btn.addEventListener(event,set(false));
    btn.addEventListener("contextmenu",e=>e.preventDefault());
});
const hornBtn=document.querySelector("[data-action=horn]");
hornBtn?.addEventListener("pointerdown",e=>{e.preventDefault();hornBtn.classList.add("on");if(window.app?.mode==="online")window.app.honk();else game.honk();});
for(const event of ["pointerup","pointercancel","pointerleave"])hornBtn?.addEventListener(event,()=>hornBtn.classList.remove("on"));
document.querySelector("[data-action=pause]")?.addEventListener("pointerdown",e=>{e.preventDefault();if(window.app?.mode==="online")window.app.stopBus();else game.togglePause();});
canvas.addEventListener("click",e=>{
    canvas.focus({preventScroll:true});
    if((window.app?.mode||"solo")!=="solo")return;
    const b=canvas.getBoundingClientRect();game.onClick((e.clientX-b.left)*WIDTH/b.width,(e.clientY-b.top)*HEIGHT/b.height);
});
const STEP=1000/60;let last=performance.now(),acc=0;
function loop(now){
    const mode=window.app?.mode||"solo";
    acc=Math.min(acc+now-last,250);last=now;
    if(mode==="solo"){
        while(acc>=STEP){game.tick();acc-=STEP;}
        game.draw();
    }else{acc=0;if(mode==="online")onlineView.draw(now);}
    requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
