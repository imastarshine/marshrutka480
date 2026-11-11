// Shared city poses are interpolated in world coordinates, then viewed by one camera.
"use strict";
class CitySession {
    constructor() {
        this.playerId = null;
        this.state = null;
        this.previous = new Map();
        this.samples = new Map();
        this.serverPerfOffset = null;
        this.lastRenderTime = -Infinity;
        this.renderDelay = 150;
        this.received = 0;
        this.buses = new Map();
        this.horns = new Map();
        this.clockOffset = 0;
        this.pendingSpawn = false;
        this.turnFrom = null;
        this.mapMarkersCount = 0;
        this.drawnPlayers = 0;
        this.authoritativeTrafficEnabled = false;
        this.trafficSamples = new Map();
        this.pedestrianSamples = new Map();
        this.trafficFirstSeen = new Map();
        this.drawnTraffic = 0;
    }
    get active() { return Boolean(this.state?.room?.mode === "city"); }
    get requiresServerTraffic() {
        return this.active || Boolean(window.app?.mode === "online" &&
            (window.app?.room?.mode === "city" || window.app?.publicWanted));
    }
    get authoritativeTraffic() { return this.active && this.authoritativeTrafficEnabled; }
    clear() {
        this.boundGame?.cityEvents?.resetEscort();
        if (this.boundGame) { this.boundGame.serverWorldEnabled = false; this.boundGame.serverCars = []; }
        this.state = null; this.previous.clear(); this.samples.clear(); this.buses.clear(); this.horns.clear();
        this.serverPerfOffset = null; this.lastRenderTime = -Infinity;
        this.turnFrom = null; this.mapMarkersCount = 0; this.drawnPlayers = 0;
        this.screenRoadCache = null;
        this.authoritativeTrafficEnabled = false; this.trafficSamples.clear(); this.pedestrianSamples.clear(); this.trafficFirstSeen.clear(); this.drawnTraffic = 0;
    }
    receive(state) {
        if (state.room?.mode !== "city") return;
        const now = performance.now();
        if (this.state && (this.state.room.code !== state.room.code || this.state.seed !== state.seed || this.state.world?.id !== state.world?.id)) {
            this.boundGame?.cityEvents?.resetEscort();
            this.samples.clear(); this.serverPerfOffset = null; this.lastRenderTime = -Infinity;
            this.trafficSamples.clear(); this.pedestrianSamples.clear(); this.trafficFirstSeen.clear(); this.authoritativeTrafficEnabled = false;
        }
        const packetTime = Number.isFinite(state.server_time) ? state.server_time * 1000 : Date.now();
        const observedOffset = packetTime - now;
        this.serverPerfOffset = this.serverPerfOffset === null ? observedOffset
            : this.serverPerfOffset + clamp(observedOffset - this.serverPerfOffset, -2, 2) * 0.2;
        for (const player of state.players || []) {
            if (!Number.isFinite(player.wx) || !Number.isFinite(player.wy)) continue;
            const time = Number.isFinite(player.pose_time) ? player.pose_time : packetTime;
            let samples = this.samples.get(player.id) || [];
            const before = samples.at(-1), elapsed = before ? Math.max(0, time - before.time) / 1000 : 0;
            if (before && Math.hypot(player.wx - before.pose.wx, player.wy - before.pose.wy) > Math.max(900, elapsed * 1400 + 300)) samples = [];
            if (!samples.length || time > samples.at(-1).time) samples.push({ time, pose: player });
            else if (time === samples.at(-1).time) samples[samples.length - 1] = { time, pose: player };
            this.samples.set(player.id, samples.slice(-20));
            if (before) this.previous.set(player.id, before.pose);
        }
        if (state.world?.authoritative_traffic === true) this.authoritativeTrafficEnabled = true;
        if (this.authoritativeTrafficEnabled && Array.isArray(state.traffic)) {
            const time = Number.isFinite(state.traffic_server_time) ? state.traffic_server_time * 1000 : packetTime;
            const trafficIds = new Set();
            for (const actor of state.traffic) {
                if (!Number.isFinite(actor.wx) || !Number.isFinite(actor.wy) || !Number.isFinite(actor.angle)) continue;
                trafficIds.add(actor.id);
                let samples = this.trafficSamples.get(actor.id) || [];
                const before = samples.at(-1);
                if (before && Math.hypot(actor.wx-before.pose.wx, actor.wy-before.pose.wy) > Math.max(900, (time-before.time)*1.4+300)) samples = [];
                if (!samples.length || time > samples.at(-1).time) samples.push({ time, pose: actor });
                this.trafficSamples.set(actor.id, samples.slice(-16));
                if (!this.trafficFirstSeen.has(actor.id)) this.trafficFirstSeen.set(actor.id, now);
            }
            for (const id of this.trafficSamples.keys()) if (!trafficIds.has(id)) {
                this.trafficSamples.delete(id); this.trafficFirstSeen.delete(id);
            }
        }
        if(Array.isArray(state.pedestrians)){
            const ids=new Set(), time=Number.isFinite(state.traffic_server_time)?state.traffic_server_time*1000:packetTime;
            for(const person of state.pedestrians){
                if(!Number.isFinite(person.wx)||!Number.isFinite(person.wy)||!Number.isFinite(person.angle))continue;
                ids.add(person.id);const samples=this.pedestrianSamples.get(person.id)||[];
                if(!samples.length||time>samples.at(-1).time)samples.push({time,pose:person});
                this.pedestrianSamples.set(person.id,samples.slice(-8));
            }
            for(const id of this.pedestrianSamples.keys())if(!ids.has(id))this.pedestrianSamples.delete(id);
        }
        this.state = state;
        this.received = now;
        this.clockOffset = state.server_time * 1000 - Date.now();
        const ids = new Set((state.players || []).map(p => p.id));
        for (const id of this.buses.keys()) if (!ids.has(id)) this.buses.delete(id);
        for (const id of this.horns.keys()) if (!ids.has(id)) this.horns.delete(id);
        for (const id of this.samples.keys()) if (!ids.has(id)) { this.samples.delete(id); this.previous.delete(id); }
    }
    players(now = performance.now()) {
        const target = Math.max(this.lastRenderTime, now + (this.serverPerfOffset ?? 0) - this.renderDelay);
        this.lastRenderTime = target;
        return (this.state?.players || []).filter(p => p.id !== this.playerId && Number.isFinite(p.wx) && Number.isFinite(p.wy)).map(p => {
            const samples = this.samples.get(p.id) || [];
            if (!samples.length) return p;
            let before = samples[0], after = null;
            for (const sample of samples) {
                if (sample.time <= target) before = sample;
                else { after = sample; break; }
            }
            if (after && after !== before) {
                const t = clamp((target - before.time) / Math.max(1, after.time - before.time), 0, 1);
                const a = before.pose, b = after.pose;
                const delta = Math.atan2(Math.sin(b.angle - a.angle), Math.cos(b.angle - a.angle));
                return { ...p, ...a, connected: p.connected, wx: a.wx + (b.wx - a.wx) * t, wy: a.wy + (b.wy - a.wy) * t,
                    lateral: a.lateral + (b.lateral - a.lateral) * t, angle: a.angle + delta * t,
                    jump: (a.jump || 0) + ((b.jump || 0) - (a.jump || 0)) * t,
                    door: (a.door || 0) + ((b.door || 0) - (a.door || 0)) * t };
            }
            const latest = samples.at(-1), old = samples.at(-2), pose = latest.pose;
            const ahead = clamp(target - latest.time, 0, 100) / 1000;
            if (old && pose.state === "play" && Math.abs(pose.speed || 0) > 0.1 && ahead) {
                const seconds = Math.max(0.02, (latest.time - old.time) / 1000);
                let vx = (pose.wx - old.pose.wx) / seconds, vy = (pose.wy - old.pose.wy) / seconds;
                const ratio = Math.min(1, 1250 / Math.max(1, Math.hypot(vx, vy)));
                vx *= ratio; vy *= ratio;
                return { ...p, ...pose, connected: p.connected, wx: pose.wx + vx * ahead, wy: pose.wy + vy * ahead };
            }
            return { ...p, ...before.pose, connected: p.connected };
        });
    }
    onReset() { this.pendingSpawn = true; this.turnFrom = null; }
    traffic(now = performance.now()) {
        if (!this.authoritativeTraffic) return [];
        const target = Math.max(this.lastRenderTime, now + (this.serverPerfOffset ?? 0) - this.renderDelay);
        const faded = clamp(1 - Math.max(0, now - this.received - 1500) / 4000, 0.3, 1);
        const result = [];
        for (const [id, samples] of this.trafficSamples) {
            let before = samples[0], after = null;
            for (const sample of samples) {
                if (sample.time <= target) before = sample;
                else { after = sample; break; }
            }
            let pose = before.pose;
            if (after && after !== before) {
                const a=before.pose, b=after.pose, t=clamp((target-before.time)/Math.max(1,after.time-before.time),0,1);
                const angle=Math.atan2(Math.sin(b.angle-a.angle),Math.cos(b.angle-a.angle));
                pose={...a,wx:a.wx+(b.wx-a.wx)*t,wy:a.wy+(b.wy-a.wy)*t,
                    lateral:(a.lateral||0)+((b.lateral||0)-(a.lateral||0))*t,angle:a.angle+angle*t};
            } else if (!after && samples.length > 1) {
                const latest=samples.at(-1), old=samples.at(-2), ahead=clamp(target-latest.time,0,100)/1000;
                pose=latest.pose;
                if (ahead && Math.abs(pose.speed||0)>0.1) {
                    const seconds=Math.max(.02,(latest.time-old.time)/1000);
                    let vx=(pose.wx-old.pose.wx)/seconds,vy=(pose.wy-old.pose.wy)/seconds;
                    const ratio=Math.min(1,1250/Math.max(1,Math.hypot(vx,vy)));
                    pose={...pose,wx:pose.wx+vx*ratio*ahead,wy:pose.wy+vy*ratio*ahead};
                }
            }
            result.push({...pose,alpha:faded*clamp((now-(this.trafficFirstSeen.get(id)??now))/180,0,1),
                collidable:now-this.received<1000});
        }
        return result;
    }
    pedestrians(now=performance.now()) {
        if(!this.authoritativeTraffic)return [];
        const target=Math.max(this.lastRenderTime,now+(this.serverPerfOffset??0)-this.renderDelay), result=[];
        for(const samples of this.pedestrianSamples.values()){
            let before=samples[0],after=null;
            for(const sample of samples){if(sample.time<=target)before=sample;else{after=sample;break;}}
            const pose=before.pose;
            if(after&&after!==before){
                const t=clamp((target-before.time)/Math.max(1,after.time-before.time),0,1),next=after.pose;
                result.push({...pose,wx:pose.wx+(next.wx-pose.wx)*t,wy:pose.wy+(next.wy-pose.wy)*t});
            }else result.push(pose);
        }
        const age=now-this.received,alpha=clamp(1-Math.max(0,age-1500)/4000,.3,1);
        return result.map(pose=>({...pose,alpha,moving:pose.moving&&age<1000}));
    }
    trafficProxies(g, now = performance.now()) {
        return this.traffic(now).map((actor) => {
            const view=this.project(g,{...actor,lateral:actor.lateral||0}),w=actor.w||CAR_W,h=actor.h||CAR_H;
            const width=Math.abs(Math.cos(view.angle))*w+Math.abs(Math.sin(view.angle))*h;
            const height=Math.abs(Math.cos(view.angle))*h+Math.abs(Math.sin(view.angle))*w;
            return {...view,id:actor.id,w,h,color:actor.color,braking:actor.braking,speed:actor.speed,
                alpha:actor.alpha,collidable:actor.collidable,rect:rect(view.x-width/2,view.y-height/2,width,height)};
        }).filter((car) => car.x>-MARGIN-200&&car.x<WIDTH+MARGIN+200&&car.y>-300&&car.y<HEIGHT+300);
    }
    drawTraffic(g) {
        this.drawnTraffic=0;
        for(const car of this.trafficProxies(g)) {
            const color=Array.isArray(car.color)&&car.color.length===3?car.color:[145,155,165];
            ctx.save();ctx.globalAlpha=car.alpha;ctx.translate(car.x,car.y);ctx.rotate(car.angle);
            drawCarBody(rect(-car.w/2,-car.h/2,car.w,car.h),color,car.braking);
            ctx.restore();this.drawnTraffic++;
        }
    }
    pose(g) {
        const {wx,wy,angle}=g.cityWorldPose;
        return {wx,wy,lateral:0,angle:Math.atan2(Math.sin(angle),Math.cos(angle)),
            speed:g.state==="play"?clamp(g.cityWorldSpeed,-4,19):0,jump:g.bus.z,door:g.bus.doorOpen,braking:g.bus.braking,
            bus:g.model.key,route:g.route.num,state:g.state,street:g.currentStreet().slice(0,60),edge:g.cityEdge.id};
    }
    beforeTick(g) {
        this.boundGame = g;
        if (!this.active) return;
        if (this.authoritativeTraffic) g.prepareSharedWorld();
        // The same intersection uses the same light phase for everyone on this street.
        const worldFrame = Math.floor((Date.now()+this.clockOffset)/1000*60);
        for (const inter of g.inters) {
            const [i,j] = g.node(inter.k);
            const direction=inter.signalDirection||g.dir;
            inter.t = worldFrame + Math.floor(hash(i,j,this.state.seed)*CYCLE) +
                (Math.abs(direction[1])>=Math.abs(direction[0])?0:CYCLE/2);
        }
    }
    color(p) {
        return /^#[0-9a-f]{6}$/i.test(p.color||"") ? [1,3,5].map(n=>parseInt(p.color.slice(n,n+2),16)) : [90,205,230];
    }
    visible(p) { return !["intro","menu","over"].includes(p.state); }
    worldPosition(p) {
        return [p.wx+Math.cos(p.angle)*(p.lateral||0),p.wy+Math.sin(p.angle)*(p.lateral||0)];
    }
    project(g,p) {
        g.cityCamera.update(g);
        const [x,y]=g.cityCamera.worldToScreen(...this.worldPosition(p));
        return {x,y,angle:p.angle-g.cityCamera.heading};
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
    drawMinimap(g,{bx,by,size,toMap,cx,cy,width=size,height=size,overview=false}) {
        this.mapMarkersCount=0;
        if (!this.active) return;
        const occupied = new Map();
        for (const p of this.players()) {
            let [x,y]=toMap(...this.worldPosition(p));
            const dx=x-cx,dy=y-cy,edgeX=width/2-12,edgeY=height/2-12;
            const outside=Math.abs(dx)>edgeX || Math.abs(dy)>edgeY;
            if (outside) {const k=Math.min(1,edgeX/Math.max(1,Math.abs(dx)),edgeY/Math.max(1,Math.abs(dy)));x=cx+dx*k;y=cy+dy*k;}
            const anchor=[x,y], cell=`${Math.round(x/13)}:${Math.round(y/13)}`, count=occupied.get(cell)||0;
            occupied.set(cell,count+1);
            if(count){x=clamp(x-(Math.floor(count/5)+1)*13,bx+12,bx+width-12);y=clamp(y+((count%5)-2)*13,by+12,by+height-12);line(anchor[0],anchor[1],x,y,this.color(p),1,.7);}
            const color=this.color(p);
            ctx.save();ctx.globalAlpha=p.connected!==false?1:.4;
            if (outside) {
                const a=Math.atan2(dy,dx);
                poly([[x+Math.cos(a)*9,y+Math.sin(a)*9],[x+Math.cos(a+2.4)*7,y+Math.sin(a+2.4)*7],[x+Math.cos(a-2.4)*7,y+Math.sin(a-2.4)*7]],color);
            } else {
                circle(x,y,9,[12,22,18]);ring(x,y,8,color,2);
                line(x+Math.sin(p.angle)*8,y-Math.cos(p.angle)*8,x+Math.sin(p.angle)*13,y-Math.cos(p.angle)*13,color,2);
            }
            text(String(p.number),x,y,color,10,{bold:true,align:"center",base:"middle"});
            const label=String(p.username||"Водитель").slice(0,overview?24:8), labelWidth=textWidth(label,overview?11:9,true);
            const labelX=clamp(x+12,bx+4,bx+width-labelWidth-4),labelY=clamp(y-19,by+4,by+height-15);
            fillRect(labelX-2,labelY-1,labelWidth+5,overview?15:12,[10,21,29],.85,2);
            text(label,labelX,labelY,color,overview?11:9,{bold:true,shadow:true});
            ctx.restore();this.mapMarkersCount++;
        }
    }
    drawOverview(g,{area,toMap}) {
        ctx.save();ctx.beginPath();ctx.rect(area.x,area.y,area.w,area.h);ctx.clip();
        this.drawMinimap(g,{bx:area.x,by:area.y,size:area.h,width:area.w,height:area.h,toMap,
            cx:area.x+area.w/2,cy:area.y+area.h/2,overview:true});
        ctx.restore();
    }
}
