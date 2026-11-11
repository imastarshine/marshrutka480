// Personal GPS: legal directed road paths, shared geographic map, no scene swaps.
"use strict";
(() => {
    const inside=(x,y,r)=>x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h;
    const nav=g=>g.gps||(g.gps={zoom:.025,x:g.wx,y:g.wy,legs:[],keys:new Set()});
    function clearPlans(g) {
        const n=nav(g);
        for(const key of n.keys)if(g.cityPlannedSelections.get(key)?.gps)g.cityPlannedSelections.delete(key);
        n.keys.clear();g.cityPlanRevision++;g.cityGeometryCache=null;g.cityNavigationCache=null;g.cityDrivingCache=null;
    }
    function plan(g) {
        const n=nav(g), target=n.target, graph=g.cityGraph;
        if(!target)return;
        const oldPlans=new Map(g.cityPlannedSelections), oldKeys=new Set(n.keys), before=g.cityWorldPose;
        clearPlans(g);n.legs=[];n.lastEdge=g.cityEdge.id;n.lastReverse=g.cityReverse;
        const heap=[],best=new Map();
        const push=item=>{heap.push(item);let i=heap.length-1;while(i){const p=(i-1)>>1;if(heap[p].score<=item.score)break;heap[i]=heap[p];i=p;}heap[i]=item;};
        const pop=()=>{const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let c=i*2+1;if(c+1<heap.length&&heap[c+1].score<heap[c].score)c++;if(heap[c].score>=last.score)break;heap[i]=heap[c];i=c;}heap[i]=last;}return first;};
        const add=(edge,reverse,from,cost,prev)=>{
            const end=reverse?0:edge.length;
            const goal=edge.id===target.edge.id&&(reverse?target.offset<=from:target.offset>=from);
            const to=goal?target.offset:end, total=cost+Math.abs(to-from), point=graph.position(edge,to);
            const key=`${edge.id}:${reverse}:${goal}`;
            if((best.get(key)??Infinity)<=total)return;
            best.set(key,total);push({edge,reverse,from,to,cost:total,goal,key,prev,
                score:total+(goal?0:Math.hypot(point[0]-target.x,point[1]-target.y))});
        };
        add(g.cityEdge,g.cityReverse,g.cityOffset,0,null);
        let found=null;
        for(let count=0;heap.length&&count<100000;count++) {
            const item=pop();if(best.get(item.key)!==item.cost)continue;
            if(item.goal){found=item;break;}
            const node=graph.endpoint(item.edge,item.reverse),key=g.citySelectionKey(item.edge,item.reverse,node);
            const fixed=g.cityWorldCommitted.get(key);
            for(const next of graph.outgoingFrom(node)) {
                if(!graph.canTurn(item.edge,node,next.edge,next.reverse))continue;
                if(fixed&&(next.edge.id!==fixed.edge.id||next.reverse!==fixed.reverse))continue;
                add(next.edge,next.reverse,next.reverse?next.edge.length:0,item.cost,item);
            }
        }
        if(!found){n.message="Нет разрешённого пути к этой точке";return;}
        for(let item=found;item;item=item.prev)n.legs.unshift({edge:item.edge,reverse:item.reverse,from:item.from,to:item.to});
        for(let i=0;i<n.legs.length-1;i++) {
            const leg=n.legs[i],next=n.legs[i+1],key=g.citySelectionKey(leg.edge,leg.reverse);
            if(g.cityWorldCommitted.has(key))continue;
            g.cityPlannedSelections.set(key,{edge:next.edge.id,reverse:next.reverse,gps:true});n.keys.add(key);
        }
        n.message="Маршрут построен";g.cityPlanRevision++;g.cityGeometryCache=null;g.cityNavigationCache=null;g.cityDrivingCache=null;
        const after=g.cityWorldPose;
        if(Math.hypot(after.wx-before.wx,after.wy-before.wy)>.1||Math.abs(Math.atan2(Math.sin(after.angle-before.angle),Math.cos(after.angle-before.angle)))>.001){
            g.cityPlannedSelections=oldPlans;n.keys=oldKeys;n.legs=[];n.message="Заверши текущий поворот — GPS перестроится";
            g.cityPlanRevision++;g.cityGeometryCache=null;g.cityNavigationCache=null;g.cityDrivingCache=null;
        }
    }
    function routeLine(g,toMap,width=4) {
        const n=nav(g);ctx.strokeStyle="#73e6ba";ctx.lineWidth=width;ctx.lineJoin="round";ctx.lineCap="round";
        for(const leg of n.legs) {
            let from=leg.from;if(leg===n.legs[0]&&leg.edge.id===g.cityEdge.id)from=g.cityOffset;
            const low=Math.min(from,leg.to),high=Math.max(from,leg.to);
            const points=[g.cityGraph.position(leg.edge,low),...leg.edge.geometry.filter((p,i)=>leg.edge.distances[i]>low&&leg.edge.distances[i]<high),g.cityGraph.position(leg.edge,high)];
            ctx.beginPath();points.forEach((p,i)=>ctx[i?"lineTo":"moveTo"](...toMap(...p)));ctx.stroke();
        }
        if(n.target){const [x,y]=toMap(n.target.x,n.target.y);circle(x,y,8,[255,114,99]);ring(x,y,12,WHITE,2);}
    }
    function remaining(g) {
        const n=nav(g);return n.legs.reduce((sum,leg,i)=>sum+Math.abs(leg.to-(i===0&&leg.edge.id===g.cityEdge.id?g.cityOffset:leg.from)),0)*METERS_PER_PX;
    }
    const tick=Game.prototype.tick;
    Game.prototype.tick=function(){tick.call(this);const n=this.gps;if(!n?.target)return;
        if(n.lastEdge!==this.cityEdge.id||n.lastReverse!==this.cityReverse)plan(this);
        const p=this.cityWorldPose;
        if(n.legs.length&&Math.hypot(p.wx-n.target.x,p.wy-n.target.y)<140&&remaining(this)<25){clearPlans(this);n.target=null;n.legs=[];this.showBanner("Вы прибыли к точке GPS",GREEN,180);}
    };
    const reset=Game.prototype.reset;
    Game.prototype.reset=function(){reset.call(this);this.gps=null;};
    const mini=Game.prototype.drawMinimap;
    Game.prototype.drawMinimap=function(){mini.call(this);if(!this.gps?.target)return;
        const r=this.minimapRect(),p=this.cityWorldPose,scale=40/BLOCK,cx=r.x+r.w/2,cy=r.y+r.h/2;
        ctx.save();ctx.beginPath();ctx.rect(r.x,r.y,r.w,r.h);ctx.clip();routeLine(this,(x,y)=>[cx+(x-p.wx)*scale,cy+(y-p.wy)*scale],3);circle(cx,cy,4,YELLOW);ctx.restore();
        text(`GPS ${Math.round(remaining(this))} м`,r.x+6,r.y+r.h-17,[115,230,186],11,{bold:true});
    };
    Game.prototype.drawRouteOverview=function(){
        const n=nav(this),area={x:18,y:106,w:WIDTH-36,h:HEIGHT-218},scale=n.zoom;
        const toMap=(x,y)=>[area.x+area.w/2+(x-n.x)*scale,area.y+area.h/2+(y-n.y)*scale];
        n.view={area,toMap,scale};
        fillRect(0,0,WIDTH,HEIGHT,[12,22,29]);text("НАВИГАТОР",22,22,WHITE,26,{bold:true});
        text("Клик — точка GPS · тяни карту · колесо — масштаб",22,61,[158,184,193],12);
        n.buttons=[{x:18,y:area.y+area.h+12,w:48,h:34,label:"−",action:"out"},{x:74,y:area.y+area.h+12,w:48,h:34,label:"+",action:"in"},
            {x:130,y:area.y+area.h+12,w:60,h:34,label:"Я",action:"center"},{x:198,y:area.y+area.h+12,w:134,h:34,label:"Весь город",action:"all"},
            {x:340,y:area.y+area.h+12,w:125,h:34,label:"Сброс GPS",action:"clear"},{x:WIDTH-146,y:20,w:126,h:33,label:"Закрыть · M",action:"close"}];
        fillRect(area.x,area.y,area.w,area.h,[25,38,46],1,8);ctx.save();ctx.beginPath();ctx.rect(area.x,area.y,area.w,area.h);ctx.clip();
        const cacheKey=`${n.x}:${n.y}:${scale}`;
        if(n.baseKey!==cacheKey){
            const output=ctx,base=document.createElement("canvas");base.width=WIDTH;base.height=HEIGHT;
            ctx=base.getContext("2d");ctx.save();ctx.beginPath();ctx.rect(area.x,area.y,area.w,area.h);ctx.clip();
        const radius=Math.max(area.w,area.h)/scale/2;
        const edges=radius>400000?[...this.cityGraph.edges.values()]:this.cityGraph.nearbyEdges(n.x,n.y,radius);
        const named=new Set();
        for(const edge of edges){
            const b=edge.bounds;if(b.minX>n.x+radius||b.maxX<n.x-radius||b.minY>n.y+radius||b.maxY<n.y-radius)continue;
            ctx.strokeStyle=this.cityRouteEdges.has(edge.id)?"#537886":"#68777c";ctx.lineWidth=Math.max(1,Math.min(8,edge.lanes*scale*24));ctx.beginPath();edge.geometry.forEach((p,i)=>ctx[i?"lineTo":"moveTo"](...toMap(...p)));ctx.stroke();
            if(scale>.012&&edge.length*scale>95&&!named.has(edge.street)&&!/^безымян/i.test(edge.street)){
                const [x,y]=toMap(...this.cityGraph.position(edge,edge.length/2));if(inside(x,y,area)){text(edge.street,x,y,[181,199,203],10,{align:"center",shadow:true});named.add(edge.street);}
            }
        }
            ctx.restore();ctx=output;n.base=base;n.baseKey=cacheKey;
        }
        ctx.drawImage(n.base,0,0);
        routeLine(this,toMap,4);window.citySession?.drawMinimap(this,{bx:area.x,by:area.y,size:area.w,width:area.w,height:area.h,toMap,cx:area.x+area.w/2,cy:area.y+area.h/2,overview:true});
        const p=this.cityWorldPose,[x,y]=toMap(p.wx,p.wy);circle(x,y,9,[12,22,29]);ring(x,y,9,YELLOW,2);
        ctx.save();ctx.translate(x,y);ctx.rotate(p.angle);poly([[0,-11],[-6,7],[0,3],[6,7]],YELLOW);ctx.restore();ctx.restore();
        for(const b of n.buttons){fillRect(b.x,b.y,b.w,b.h,[43,62,70],1,6);text(b.label,b.x+b.w/2,b.y+b.h/2,WHITE,12,{align:"center",base:"middle",bold:true});}
        const value=remaining(this);text(n.target?(n.legs.length?`До точки: ${value>=1000?(value/1000).toFixed(1)+" км":Math.round(value)+" м"} · ${n.target.edge.street}`:n.message):(n.message||"Поставь точку на дороге — GPS построит путь"),22,HEIGHT-49,n.target?GREEN:WHITE,13,{bold:true});
        text("M / Esc — за руль · стрелки — сдвиг карты · © OpenStreetMap",22,HEIGHT-24,[151,175,183],11);
    };
    const click=Game.prototype.onClick;
    Game.prototype.onClick=function(x,y){if(!this.mapOverview)return click.call(this,x,y);
        const n=nav(this);if(n.dragged){n.dragged=false;return;}
        const button=n.buttons?.find(b=>inside(x,y,b));
        if(button){if(button.action==="close")this.toggleRouteMap();if(button.action==="in")n.zoom=Math.min(.8,n.zoom*1.6);if(button.action==="out")n.zoom=Math.max(.00015,n.zoom/1.6);if(button.action==="center"){n.x=this.wx;n.y=this.wy;}if(button.action==="clear"){clearPlans(this);n.target=null;n.legs=[];n.message="";}
            if(button.action==="all"){const nodes=[...this.cityGraph.nodes.values()],xs=nodes.map(p=>p.x),ys=nodes.map(p=>p.y),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);n.x=(minX+maxX)/2;n.y=(minY+maxY)/2;n.zoom=Math.min((WIDTH-65)/(maxX-minX),(HEIGHT-240)/(maxY-minY));}return;}
        const v=n.view;if(!v||!inside(x,y,v.area))return;
        const wx=n.x+(x-v.area.x-v.area.w/2)/v.scale,wy=n.y+(y-v.area.y-v.area.h/2)/v.scale;
        let nearest=null;for(const edge of this.cityGraph.nearbyEdges(wx,wy,25/v.scale)){const p=this.cityGraph.project(edge,wx,wy);if(!nearest||p.distance<nearest.distance)nearest={...p,edge};}
        if(nearest&&nearest.distance*v.scale<24){n.target={edge:nearest.edge,offset:nearest.offset,x:nearest.point[0],y:nearest.point[1]};plan(this);}else n.message="Выбери точку ближе к дороге";
    };
    const key=Game.prototype.onKey;
    Game.prototype.onKey=function(code,down){if(this.mapOverview&&down&&["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Equal","Minus"].includes(code)){
        const n=nav(this),step=90/n.zoom;if(code==="ArrowLeft")n.x-=step;if(code==="ArrowRight")n.x+=step;if(code==="ArrowUp")n.y-=step;if(code==="ArrowDown")n.y+=step;if(code==="Equal")n.zoom=Math.min(.8,n.zoom*1.6);if(code==="Minus")n.zoom=Math.max(.00015,n.zoom/1.6);return;
    }return key.call(this,code,down);};
    const toggle=Game.prototype.toggleRouteMap;
    Game.prototype.toggleRouteMap=function(){if(!this.mapOverview){const n=nav(this);n.x=this.wx;n.y=this.wy;}return toggle.call(this);};
    let drag=null;
    canvas.addEventListener("wheel",event=>{if(!game.mapOverview)return;event.preventDefault();const n=nav(game);n.zoom=clamp(n.zoom*(event.deltaY<0?1.25:.8),.00015,.8);},{passive:false});
    canvas.addEventListener("pointerdown",event=>{if(!game.mapOverview)return;const n=nav(game),r=canvas.getBoundingClientRect(),x=(event.clientX-r.left)*WIDTH/r.width,y=(event.clientY-r.top)*HEIGHT/r.height;if(n.view&&inside(x,y,n.view.area)){n.dragged=false;drag={x:event.clientX,y:event.clientY,cx:n.x,cy:n.y,zoom:n.zoom};canvas.setPointerCapture(event.pointerId);}});
    canvas.addEventListener("pointermove",event=>{if(!drag||!game.mapOverview)return;const n=nav(game),r=canvas.getBoundingClientRect(),dx=(event.clientX-drag.x)*WIDTH/r.width,dy=(event.clientY-drag.y)*HEIGHT/r.height;if(Math.hypot(dx,dy)>5){n.dragged=true;n.x=drag.cx-dx/drag.zoom;n.y=drag.cy-dy/drag.zoom;}});
    for(const type of ["pointerup","pointercancel"])canvas.addEventListener(type,()=>{drag=null;});
})();
