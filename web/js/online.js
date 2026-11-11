// Multiplayer is an overlay on the original Game. Only remote buses interpolate.
"use strict";
class CitySession {
    constructor() {
        this.playerId = null;
        this.state = null;
        this.previous = new Map();
        this.received = 0;
        this.buses = new Map();
        this.horns = new Map();
        this.clockOffset = 0;
        this.pendingSpawn = false;
        this.turnFrom = null;
        this.mapMarkersCount = 0;
        this.drawnPlayers = 0;
    }
    get active() { return Boolean(this.state?.room?.mode === "city"); }
    clear() {
        this.state = null; this.previous.clear(); this.buses.clear(); this.horns.clear();
        this.turnFrom = null; this.mapMarkersCount = 0; this.drawnPlayers = 0;
    }
    receive(state) {
        if (state.room?.mode !== "city") return;
        const now = performance.now();
        this.previous = new Map(this.players(now).map(p => [p.id, p]));
        this.state = state;
        this.received = now;
        this.clockOffset = state.server_time * 1000 - Date.now();
        const ids = new Set(state.players.map(p => p.id));
        for (const id of this.buses.keys()) if (!ids.has(id)) this.buses.delete(id);
        for (const id of this.horns.keys()) if (!ids.has(id)) this.horns.delete(id);
    }
    players(now = performance.now()) {
        const t = clamp((now - this.received) / 100, 0, 1);
        return (this.state?.players || []).filter(p => p.id !== this.playerId && Number.isFinite(p.wx)).map(p => {
            const before = this.previous.get(p.id);
            if (!before || Math.hypot(p.wx - before.wx, p.wy - before.wy) > 900) return p;
            const angleDelta = Math.atan2(Math.sin(p.angle - before.angle), Math.cos(p.angle - before.angle));
            return {...p, wx:before.wx+(p.wx-before.wx)*t, wy:before.wy+(p.wy-before.wy)*t,
                lateral:before.lateral+(p.lateral-before.lateral)*t, angle:before.angle+angleDelta*t};
        });
    }
    onReset() { this.pendingSpawn = true; this.turnFrom = null; if(window.app)window.app.garageReturnState=null; }
    captureTurn(g) { this.turnFrom = {wx:g.wx, wy:g.wy, angle:Math.atan2(g.dir[0], -g.dir[1])}; }
    pose(g) {
        let wx = g.wx, wy = g.wy, angle = Math.atan2(g.dir[0], -g.dir[1]);
        if (g.state === "turning" && this.turnFrom) {
            const t = smooth(1-g.turnT/g.turnTotal);
            wx = this.turnFrom.wx+(wx-this.turnFrom.wx)*t;
            wy = this.turnFrom.wy+(wy-this.turnFrom.wy)*t;
            const delta = Math.atan2(Math.sin(angle-this.turnFrom.angle), Math.cos(angle-this.turnFrom.angle));
            angle = this.turnFrom.angle+delta*t;
        }
        return {wx,wy,lateral:g.bus.x-roadMiddle(),angle:Math.atan2(Math.sin(angle),Math.cos(angle)),
            speed:g.state==="play"?g.bus.speed:0,jump:g.bus.z,door:g.bus.doorOpen,braking:g.bus.braking,
            bus:g.model.key,route:g.route.num,state:g.state,street:g.currentStreet()};
    }
    beforeTick(g) {
        if (!this.active) return;
        // The same intersection uses the same light phase for everyone on this street.
        const worldFrame = Math.floor((Date.now()+this.clockOffset)/1000*60);
        for (const inter of g.inters) {
            const [i,j] = g.node(inter.k);
            inter.t = worldFrame + Math.floor(hash(i,j,this.state.seed)*CYCLE) + (g.vertical?0:GREEN_T+YELLOW_T);
        }
    }
    color(p) {
        return /^#[0-9a-f]{6}$/i.test(p.color||"") ? [1,3,5].map(n=>parseInt(p.color.slice(n,n+2),16)) : [90,205,230];
    }
    visible(p) { return !["intro","menu","over"].includes(p.state); }
    worldPosition(p) {
        return [p.wx+Math.cos(p.angle)*p.lateral,p.wy+Math.sin(p.angle)*p.lateral];
    }
    project(g,p) {
        const [wx,wy] = this.worldPosition(p), dx = wx-g.wx, dy = wy-g.wy;
        return {x:roadMiddle()-g.dir[1]*dx+g.dir[0]*dy,
            y:g.bus.centerY-g.dir[0]*dx-g.dir[1]*dy,
            angle:p.angle-Math.atan2(g.dir[0],-g.dir[1])};
    }
    drawPlayers(g) {
        this.drawnPlayers = 0;
        if (!this.active) return;
        const now = performance.now();
        for (const p of this.players(now)) {
            if (!this.visible(p)) continue;
            const view = this.project(g,p);
            if (view.x < -MARGIN-160 || view.x > WIDTH+MARGIN+160 || view.y < -200 || view.y > HEIGHT+200) continue;
            let bus = this.buses.get(p.id);
            if (!bus || bus.model.key !== p.bus || bus.route !== p.route) {
                const model = BUS_MODELS.find(b=>b.key===p.bus)||BUS_MODELS[0];
                bus = new Bus({},model,p.route);this.buses.set(p.id,bus);
            }
            bus.speed=p.speed;bus.braking=p.braking;bus.doorOpen=p.door;
            ctx.save();ctx.globalAlpha=p.connected?0.95:0.35;
            bus.draw(g.frame,{...view,y:view.y-(p.jump||0)*.3});
            const label = p.number+" · "+p.username;
            const w = Math.min(200,textWidth(label,12,true)+18);
            fillRect(view.x-w/2,view.y-bus.h/2-29,w,22,[14,23,20],.94,4);
            text(label,view.x,view.y-bus.h/2-18,this.color(p),12,{bold:true,align:"center",base:"middle"});
            if ((this.horns.get(p.id)||0)>now) {
                text("БИП!",view.x+bus.w/2+8,view.y-20,YELLOW,14,{bold:true});
                ring(view.x,view.y-bus.h/2,42+(now%250)/12,this.color(p),2);
            }
            ctx.restore();this.drawnPlayers++;
        }
    }
    drawMinimap(g,{bx,by,size,toMap,cx,cy}) {
        this.mapMarkersCount=0;
        if (!this.active) return;
        for (const p of this.players()) {
            if (!this.visible(p)) continue;
            let [x,y]=toMap(...this.worldPosition(p));
            const dx=x-cx,dy=y-cy,edge=size/2-12;
            const outside=Math.max(Math.abs(dx),Math.abs(dy))>edge;
            if (outside) {const k=edge/Math.max(Math.abs(dx),Math.abs(dy));x=cx+dx*k;y=cy+dy*k;}
            const color=this.color(p);
            ctx.save();ctx.globalAlpha=p.connected?1:.4;
            if (outside) {
                const a=Math.atan2(dy,dx);
                poly([[x+Math.cos(a)*9,y+Math.sin(a)*9],[x+Math.cos(a+2.4)*7,y+Math.sin(a+2.4)*7],[x+Math.cos(a-2.4)*7,y+Math.sin(a-2.4)*7]],color);
            } else {
                circle(x,y,9,[12,22,18]);ring(x,y,8,color,2);
                line(x+Math.sin(p.angle)*8,y-Math.cos(p.angle)*8,x+Math.sin(p.angle)*13,y-Math.cos(p.angle)*13,color,2);
            }
            text(String(p.number),x,y,color,10,{bold:true,align:"center",base:"middle"});
            const labelX=clamp(x+12,bx+4,bx+size-60);
            text(p.username.slice(0,8),labelX,clamp(y-19,by+4,by+size-14),color,9,{bold:true,shadow:true});
            ctx.restore();this.mapMarkersCount++;
        }
    }
}
