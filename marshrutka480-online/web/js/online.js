// Presentation only: movement, passengers and scores are authoritative on the server.
"use strict";
class OnlineView {
    constructor() { this.previous = null; this.state = null; this.received = 0; this.buses = new Map(); this.playerId = null; this.horns = new Map(); }
    reset() { this.previous = null; this.state = null; this.buses.clear(); }
    receive(state) {
        this.previous = this.state;
        this.state = state;
        this.received = performance.now();
        if (this.previous?.room?.status !== state.room?.status) this.previous = null;
    }
    color(value) {
        if (Array.isArray(value)) return value;
        if (/^#[0-9a-f]{6}$/i.test(value || "")) return [1, 3, 5].map(n => parseInt(value.slice(n, n + 2), 16));
        return [243, 206, 86];
    }
    entities(name, now) {
        const current = this.state?.[name] || [];
        if (!this.previous) return current;
        const old = new Map((this.previous[name] || []).map(e => [e.id, e]));
        const t = clamp((now - this.received) / 100, 0, 1);
        return current.map(e => {
            const before = old.get(e.id);
            return before ? { ...e, x: before.x + (e.x - before.x) * t, z: before.z + (e.z - before.z) * t } : e;
        });
    }
    draw(now) {
        ctx = screenCtx;
        ctx.save();
        const players = this.entities("players", now);
        const me = players.find(p => p.id === this.playerId) || players[0];
        const z = me?.z || 0;
        const active = this.state?.room?.status || "welcome";
        this.drawRoad(z, now);
        for (const stop of this.state?.stops || []) this.drawStop(stop, z, me);
        for (const car of this.entities("npcs", now)) {
            const y = 600 - (car.z - z);
            if (y < -120 || y > 880) continue;
            ctx.save();ctx.translate(car.x, y);if (car.speed < 0) ctx.rotate(Math.PI);
            drawCarBody({ x:-25, y:-46, w:50, h:92 }, this.color(car.color), false);ctx.restore();
        }
        const ordered = players.slice().sort((a,b) => Number(a.id === this.playerId) - Number(b.id === this.playerId));
        for (const p of ordered) this.drawPlayer(p, z, now);
        if (!players.length) this.drawPlayer({ id:-1, username:"ТВОЯ ГАЗЕЛЬ", color:"#f3ce56", x:411, z:0, speed:0, score:0, connected:true }, z, now);
        this.drawHud(me, active, now);
        if (active === "welcome") this.overlay("НА ОДНОЙ ВОЛНЕ", ["Иркутск. Маршрут 480. Общий рейс.", "Войди и создай комнату — или введи код друга.", "До 8 водителей · 3 минуты · один город"], "02 / СЕТЕВОЙ РЕЖИМ");
        if (active === "waiting") this.overlay("СОБИРАЕМ ЭКИПАЖ", [this.state.room.name, `Комната ${this.state.room.code} · ${players.length} на линии`, "Пригласи друзей и нажми «Начать общий рейс»."], "ДИСПЕТЧЕР НА СВЯЗИ");
        if (active === "countdown") {
            panel(230,270,180,180,.94,YELLOW);
            text(String(Math.max(1,Math.ceil(this.state.countdown || 1))),320,350,YELLOW,94,{bold:true,align:"center",base:"middle"});
            text("ПОЕХАЛИ ЧЕРЕЗ",320,290,[172,184,163],12,{align:"center"});
        }
        if (active === "finished") {
            const result = this.state.results?.find(p => p.id === this.playerId);
            this.overlay("СМЕНА ЗАВЕРШЕНА", [`Твоя выручка: ${result?.score ?? me?.score ?? 0} ₽`, `Остановок: ${result?.stops ?? me?.stops ?? 0} · Увидимся на следующем рейсе`, result?.qualified ? "Результат сохранён в общем рейтинге." : "Для рейтинга обслужи хотя бы одну остановку."], "СПАСИБО ЗА СМЕНУ");
        }
        ctx.restore();
    }
    drawRoad(z, now) {
        fillRect(0,0,640,760,[78,91,67]);
        for (let k = Math.floor((z-250)/400); k <= Math.ceil((z+900)/400); k++) {
            const y = 600 - (k*400-z), r = seeded(k * 1171 + 7625);
            const shade = Math.floor(r()*25);
            fillRect(5,y-190,57,145,[112+shade,107+shade,89+shade],1,3);
            fillRect(11,y-185,45,136,[132+shade,121+shade,99+shade],1,2);
            for(let wy=0;wy<6;wy++) for(let wx=0;wx<2;wx++) fillRect(17+wx*22,y-175+wy*21,11,12,[72,84,80]);
            fillRect(4,y-45,61,8,[67,72,59]);
            tree(36,y+28,17);tree(30,y+100,22);
            fillRect(608,y-140,32,125,[124,109,89]);
            fillRect(614,y-134,26,114,[145,129,101]);
            for(let wy=0;wy<5;wy++) fillRect(619,y-124+wy*21,12,11,[78,87,82]);
            tree(624,y+68,18);
        }
        fillRect(68,0,10,760,[148,151,132]);
        fillRect(78,0,444,760,[59,65,59]);
        fillRect(522,0,68,760,[74,79,69]);
        fillRect(590,0,10,760,[148,151,132]);
        for (let y = mod(z, 30)-30; y < 790; y+=30) {
            fillRect(68,y,5,15,[192,191,169]);fillRect(595,y,5,15,[192,191,169]);
        }
        line(294,0,294,760,[213,199,115],2);line(302,0,302,760,[213,199,115],2);
        for (const x of [152,226,374,448]) for(let y=mod(z,94)-94;y<850;y+=94) fillRect(x,y,3,42,[188,194,176]);
        line(86,0,86,760,[178,188,168],2);line(516,0,516,760,[178,188,168],2);
        for(let y=mod(z,96)-96;y<850;y+=96) fillRect(525,y,3,42,[178,188,168]);
        for(let k=Math.floor((z-300)/3600);k<=Math.ceil((z+900)/3600);k++) {
            const y=600-(k*3600-z);
            if(y < -100 || y > 850) continue;
            fillRect(78,y-55,444,110,[61,67,60]);
            for(let x=94;x<510;x+=28) {fillRect(x,y-50,15,20,[187,190,171]);fillRect(x,y+32,15,20,[187,190,171]);}
            line(78,y-65,522,y-65,[141,152,131],2);line(78,y+65,522,y+65,[141,152,131],2);
        }
    }
    drawStop(stop, z, me) {
        const y = 600-(stop.z-z);if(y < -190 || y > 950) return;
        const next = stop.id === me?.next_stop;
        const c = stop.waiting > 0 ? [243,206,86] : [137,147,130];
        fillRect(523,y-135,66,270,[96,98,72]);
        strokeRect(530,y-127,51,254,c,next?3:1,5,.85);
        for(let dy=-105;dy<120;dy+=28) line(531,y+dy,541,y+dy-10,c,2,.5);
        fillRect(597,y-96,38,95,[41,52,46],1,3);
        fillRect(595,y-99,42,10,[110,158,123],1,2);
        for(let i=0;i<Math.min(stop.waiting,6);i++){const px=604+(i%2)*18,py=y+15+Math.floor(i/2)*21;fillRect(px-4,py,8,11,PEOPLE_COLORS[i%PEOPLE_COLORS.length],1,2);circle(px,py-4,4,SKIN);}
        fillRect(591,y-149,5,37,[171,180,161]);fillRect(581,y-160,26,25,[81,137,183],1,3);text("А",594,y-147,WHITE,17,{bold:true,align:"center",base:"middle"});
        const w=Math.min(300,textWidth(stop.name,14,true)+30);
        panel(640-w-20,y-192,w,30,.94,c);text(stop.name,630-w+5,y-176,c,14,{bold:true,base:"middle"});
        if(next) {text("ТВОЯ ОСТАНОВКА",513,y+154,YELLOW,11,{bold:true,align:"right"});text(`${stop.waiting} пассажиров`,581,y+138,c,11,{align:"right"});}
    }
    drawPlayer(p, z, now) {
        const y=600-(p.z-z);if(y < -170 || y > 930) return;
        let bus=this.buses.get(p.id);
        if(!bus){bus=new Bus({}, {...BUS_MODELS[0],color:this.color(p.color)},"480");this.buses.set(p.id,bus);}
        bus.speed=p.speed/60;bus.braking=p.id===this.playerId && Boolean(window.app?.keys.down);bus.doorOpen=p.boarding>0?1:0;
        ctx.save();if(!p.connected)ctx.globalAlpha=.45;if(p.invulnerable && Math.floor(now/120)%2)ctx.globalAlpha=.65;
        bus.draw(Math.floor(now/16),{x:p.x,y,angle:0});ctx.restore();
        const own=p.id===this.playerId;
        if(own) {ring(p.x,y+76,5,YELLOW,2);line(p.x,y+66,p.x,y+71,YELLOW,2);}
        const name=own?`${p.username} · ТЫ`:p.username;
        const width=textWidth(name,12,true)+18;
        fillRect(p.x-width/2,y-84,width,22,[20,27,22],.94,5);
        text(name,p.x,y-73,own?YELLOW:this.color(p.color),12,{bold:true,align:"center",base:"middle"});
        if(p.boarding>0) {fillRect(p.x-29,y+65,58,5,[28,41,27],1,3);fillRect(p.x-29,y+65,58*p.boarding,5,GREEN,1,3);}
        if((this.horns.get(p.id)||0)>now) {ring(p.x,y-52,60+(now%300)/20,YELLOW,2);text("БИП!",p.x+42,y-20,YELLOW,14,{bold:true});}
    }
    drawHud(me, active, now) {
        fillRect(0,0,640,94,[20,27,23],.96);
        fillRect(16,15,61,40,YELLOW,1,6);text("480",46,36,BLACK,26,{bold:true,align:"center",base:"middle"});
        text(me?.street || this.state?.street || "ИРКУТСК · ОБЩИЙ РЕЙС",93,17,WHITE,16,{bold:true});
        text(`${this.state?.room?.code || "ДИСПЕТЧЕРСКАЯ"}  /  ${this.state?.players?.length || 0} НА ЛИНИИ`,94,43,[155,174,147],11);
        const seconds=Math.max(0,Math.ceil(this.state?.time_left??180));
        text(`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")}`,620,18,YELLOW,25,{bold:true,align:"right"});
        text(active==="running"?"ДО КОНЦА СМЕНЫ":"ОБЩИЙ РЕЙС",620,48,[155,174,147],10,{align:"right"});
        line(16,65,624,65,[61,75,58],1);
        text(`${Math.round((me?.speed||0)*7/60)} км/ч`,20,75,WHITE,12,{bold:true});
        text(`${me?.score??0} ₽`,170,75,YELLOW,12,{bold:true});
        text(`ОСТАНОВОК ${me?.stops??0}`,305,75,[173,190,164],11);
        const ping=window.app?.latency;
        text(ping!=null?`${ping} мс`:(active==="welcome"?"ОНЛАЙН":"НА СВЯЗИ"),620,75,[173,190,164],11,{align:"right"});
        if(active==="running") {
            const stop=(this.state.stops||[]).find(s=>s.id===me?.next_stop);
            panel(16,683,608,61,.94,[92,115,81]);
            if(me?.boarding>0){text("ПОСАДКА ПАССАЖИРОВ",30,696,YELLOW,13,{bold:true});text("Держи тормоз, пока двери открыты",30,719,[181,198,170],12);}
            else if(stop){text(`ДАЛЬШЕ: ${stop.name}`,30,696,YELLOW,13,{bold:true});const distance=Math.max(0,Math.round((stop.z-me.z)*METERS_PER_PX));text(`Через ${distance} м · в правый карман и полный тормоз`,30,719,[181,198,170],12);}
            else{text("ГОРОД НА СВЯЗИ",30,696,YELLOW,13,{bold:true});text("Газ — W / ↑    Руль — A D / ← →    Тормоз — S / ↓",30,719,[181,198,170],12);}
        }
    }
    overlay(title, lines, eyebrow) {
        fillRect(0,95,640,665,[11,19,14],.56);
        panel(37,230,566,240,.96,[113,130,87]);
        text(eyebrow,320,257,[159,181,140],12,{align:"center"});
        text(title,320,292,YELLOW,31,{bold:true,align:"center"});
        line(180,338,460,338,[73,92,58],1);
        lines.forEach((v,i)=>text(v,320,360+i*30,i===0?WHITE:[166,186,151],14,{align:"center"}));
    }
}
