// Dispatch UI and a small WebSocket transport around the original game.
"use strict";
class MarshrutkaApp {
    constructor(){
        this.token=null;this.user=null;this.room=null;this.ws=null;this.socketReady=false;
        this.seq=0;this.authMode="login";this.latency=null;this.healthy=false;
        this.mode="solo";this.panelView=null;this.panelOpen=false;this.pausedForPanel=false;
        this.reconnectTimer=null;this.reconnectDeadline=0;this.reconnectAttempt=0;
        this.connectionVersion=0;this.roomRequest=false;this.lastHorn=0;this.lastRoster="";
        this.pendingCode=null;this.toastTimer=null;this.base="";
        try{
            const raw=(window.MARSHRUTKA_CONFIG?.API_BASE||"").trim();
            if(raw){const u=new URL(raw);if(!["http:","https:"].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error();this.base=u.origin;}
        }catch(_){this.badConfig=true;}
        this.bind();this.syncLayout();this.health();this.refreshChrome();
        matchMedia("(max-width: 1179px), (max-aspect-ratio: 4/3)").addEventListener("change",()=>this.syncLayout());
        setInterval(()=>this.sendPose(),50);
        setInterval(()=>{if(this.socketReady)this.send({type:"ping",t:Date.now()});},3000);
        setInterval(()=>{this.refreshChrome();this.renderRoster();},500);
        setInterval(()=>{if(this.panelView==="friends"&&!this.room&&this.healthy)this.loadRooms();},15000);
        const code=new URLSearchParams(location.search).get("room");
        if(code&&/^[A-Z2-9]{6}$/i.test(code)){this.pendingCode=code.toUpperCase();this.el("room-code").value=this.pendingCode;this.openPanel("friends");this.status("room-status","Приглашение открыто. Войди, чтобы присоединиться.");}
    }
    el(id){return document.getElementById(id);}
    status(id,message,error=false){const el=this.el(id);el.textContent=message;el.classList.toggle("error",error);}
    toast(message){const el=this.el("toast");el.textContent=message;el.hidden=false;clearTimeout(this.toastTimer);this.toastTimer=setTimeout(()=>el.hidden=true,4500);}
    bind(){
        const click=(id,fn)=>this.el(id).addEventListener("click",fn);
        click("solo-mode",()=>this.selectSolo());click("online-mode",()=>this.openPanel("friends"));
        click("account-button",()=>this.openPanel("account"));click("room-drive",()=>this.closePanel());
        click("close-panel",()=>this.closePanel());click("panel-scrim",()=>this.closePanel());
        click("show-login",()=>this.authTab("login"));click("show-register",()=>this.authTab("register"));
        click("toggle-password",()=>{const p=this.el("password");p.type=p.type==="password"?"text":"password";this.el("toggle-password").setAttribute("aria-label",p.type==="password"?"Показать пароль":"Скрыть пароль");});
        this.el("auth-form").addEventListener("submit",e=>{e.preventDefault();this.authenticate();});
        this.el("create-room-form").addEventListener("submit",e=>{e.preventDefault();this.createRoom();});
        this.el("join-room-form").addEventListener("submit",e=>{e.preventDefault();this.joinRoom(this.el("room-code").value);});
        click("logout",()=>this.logout());click("retry-server",()=>this.health());click("refresh-rooms",()=>this.loadRooms());
        click("room-leave",()=>this.leaveRoom());click("copy-room",()=>this.copyInvite());
        document.addEventListener("focusin",e=>{if(isTextControl(e.target)){releaseKeys();if(game.state==="play"){game.state="pause";this.pausedForPanel=true;}}});
    }
    syncLayout(){
        this.mobileLayout=matchMedia("(max-width: 1179px), (max-aspect-ratio: 4/3)").matches;
        const panel=this.el("dispatch-panel");
        this.panelOpen=Boolean(this.panelView&&!this.mobileLayout);
        panel.hidden=!this.panelView;
        this.el("panel-scrim").hidden=!this.panelOpen;
        panel.setAttribute("role",this.mobileLayout?"region":"dialog");
        if(this.mobileLayout)panel.removeAttribute("aria-modal");
        else panel.setAttribute("aria-modal","true");
    }
    openPanel(kind="friends"){
        if(!this.panelView){this.pausedForPanel=game.state==="play";if(this.pausedForPanel)game.state="pause";}
        if(kind==="friends")this.mode="online";
        releaseKeys();this.panelView=kind;this.syncLayout();
        this.el("panel-title").textContent={friends:"Сетевая игра",account:"Мой позывной"}[kind];
        this.el("online-section").hidden=kind!=="friends";
        this.refreshChrome();
        if(this.mobileLayout)this.el("dispatch-panel").scrollIntoView({behavior:"smooth",block:"start"});
        else this.el("close-panel").focus({preventScroll:true});
        if(kind==="friends"){this.loadRooms();this.renderRoom();}
    }
    closePanel(){
        this.panelView=null;this.syncLayout();
        if(this.mobileLayout)this.el("game-frame").scrollIntoView({behavior:"smooth",block:"start"});
        if(this.pausedForPanel&&game.state==="pause")game.state="play";
        this.pausedForPanel=false;releaseKeys();canvas.focus({preventScroll:true});this.refreshChrome();
    }
    trapFocus(event){
        const items=[...this.el("dispatch-panel").querySelectorAll("button,input,select,a[href]")].filter(e=>!e.disabled&&e.getClientRects().length);
        if(!items.length)return;
        if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items.at(-1).focus();}
        else if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0].focus();}
    }
    async selectSolo(){
        this.mode="solo";this.pendingCode=null;
        this.closePanel();
        await this.leaveRoom();
    }
    async fullscreen(){
        try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}
        catch(_){this.toast("Этот браузер не поддерживает полный экран. Игровой экран уже подстроен под окно.");}
    }
    refreshChrome(){
        for(const mode of ["solo","online"]){
            const button=this.el(mode+"-mode"),selected=this.mode===mode;
            button.classList.toggle("active",selected);button.setAttribute("aria-pressed",String(selected));
        }
        this.el("online-mode").setAttribute("aria-expanded",String(this.panelView==="friends"));
        this.el("account-button").setAttribute("aria-expanded",String(this.panelView==="account"));
        this.el("latency").textContent=this.socketReady?(this.latency===null?"НА СВЯЗИ":this.latency+" мс · В ГОРОДЕ"):"ЛОКАЛЬНЫЙ РЕЙС";
    }
    authTab(mode){
        this.authMode=mode;this.el("show-login").classList.toggle("selected",mode==="login");
        this.el("show-register").classList.toggle("selected",mode==="register");
        this.el("password").autocomplete=mode==="login"?"current-password":"new-password";
        this.el("auth-submit").textContent=mode==="login"?"Войти":"Получить позывной";
        this.status("auth-status","");
    }
    async api(path,options={}){
        const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
        try{
            const response=await fetch(this.base+path,{method:options.method||"GET",credentials:"omit",cache:"no-store",signal:controller.signal,
                headers:{Accept:"application/json",...(options.body!==undefined?{"Content-Type":"application/json"}:{}),...(this.token?{Authorization:"Bearer "+this.token}:{})},
                body:options.body!==undefined?JSON.stringify(options.body):undefined});
            let data;try{data=await response.json();}catch(_){throw Error("Диспетчер не отвечает. Попробуй ещё раз чуть позже.");}
            if(!response.ok){
                if(response.status===401&&this.token)this.expireSession();
                throw Error(typeof data.detail==="string"?data.detail:"Проверь позывной, пароль или код комнаты.");
            }
            return data;
        }catch(error){
            if(error.name==="AbortError")throw Error("Сервер долго не отвечает. Попробуй ещё раз.");
            if(error instanceof TypeError)throw Error("Нет связи с диспетчером. Свой рейс можно продолжить.");
            throw error;
        }finally{clearTimeout(timeout);}
    }
    async health(){
        this.el("retry-server").hidden=true;
        try{
            if(this.badConfig)throw Error();
            const data=await this.api("/api/health");
            if(!data.ok||!data.features?.includes("original-city"))throw Error();
            this.healthy=true;this.el("server-led").className="status-led online";this.el("server-status").textContent="Диспетчер на связи";
        }catch(_){
            this.healthy=false;this.el("server-led").className="status-led offline";this.el("server-status").textContent="Без связи · свой рейс доступен";this.el("retry-server").hidden=false;
        }
    }
    showUser(){
        this.el("auth-guest").hidden=!!this.user;this.el("auth-user").hidden=!this.user;
        this.el("driver-name").textContent=this.user?.username||"";
        const initial=(this.user?.username||"Я").slice(0,1).toUpperCase();
        this.el("driver-avatar").textContent=initial;this.el("account-initial").textContent=initial;
    }
    async authenticate(){
        const button=this.el("auth-submit");if(button.disabled)return;
        button.disabled=true;this.status("auth-status","Проверяем удостоверение…");
        try{
            const data=await this.api("/api/auth/"+this.authMode,{method:"POST",body:{username:this.el("username").value.trim(),password:this.el("password").value}});
            this.token=data.token;this.user=data.user;this.el("password").value="";this.showUser();
            this.status("auth-status","Ты на связи. Можно звать друзей.");this.status("room-status","");
            if(this.pendingCode){const code=this.pendingCode;this.pendingCode=null;await this.joinRoom(code);}
            this.health();
        }catch(e){this.status("auth-status",e.message,true);}finally{button.disabled=false;}
    }
    expireSession(){
        this.closeSocket();this.room=null;this.user=null;this.token=null;citySession.clear();this.showUser();this.renderRoom();
        this.status("auth-status","Сессия закончилась. Войди снова.",true);
    }
    async logout(){
        const button=this.el("logout");if(button.disabled)return;button.disabled=true;
        try{await this.leaveRoom();await this.api("/api/auth/logout",{method:"POST",body:{}});}
        catch(e){this.status("auth-status",e.message,true);}
        finally{this.expireSession();this.status("auth-status","Ты вышел из аккаунта.");button.disabled=false;}
    }
    requireUser(){
        if(this.token)return true;
        this.openPanel("friends");this.status("auth-status","Сначала войди или получи позывной.",true);this.el("username").focus();return false;
    }
    async createRoom(){
        if(!this.requireUser()||this.roomRequest)return;
        this.roomRequest=true;const button=this.el("create-room-form").querySelector("button");button.disabled=true;
        this.status("room-status","Создаём комнату…");
        try{
            const data=await this.api("/api/rooms",{method:"POST",body:{name:this.el("room-name").value.trim(),public:!this.el("room-private").checked,max_players:Number(this.el("room-max-players").value),mode:"city"}});
            await this.enterRoom(data.room);
        }catch(e){this.status("room-status",e.message,true);}finally{button.disabled=false;this.roomRequest=false;}
    }
    async joinRoom(raw){
        const code=String(raw).trim().toUpperCase();
        if(!/^[A-Z2-9]{6}$/.test(code)){this.status("room-status","Код состоит из шести латинских букв и цифр.",true);return;}
        if(!this.requireUser()){this.pendingCode=code;return;}
        if(this.roomRequest)return;this.roomRequest=true;this.status("room-status","Подключаемся…");
        try{
            if(this.room&&this.room.code!==code)await this.leaveRoom();
            const data=await this.api("/api/rooms/"+code+"/join",{method:"POST",body:{}});
            if(data.room.mode!=="city"){
                await this.api("/api/rooms/"+code+"/leave",{method:"POST",body:{}});
                throw Error("Комната из старой версии игры. Создай новую для поездки по городу.");
            }
            await this.enterRoom(data.room);
        }catch(e){this.status("room-status",e.message,true);}finally{this.roomRequest=false;}
    }
    async enterRoom(room){
        // A room request can finish after the player has selected solo mode.
        if(this.mode!=="online"){
            await this.api("/api/rooms/"+room.code+"/leave",{method:"POST",body:{}});
            return;
        }
        this.closeSocket();this.room=room;citySession.clear();citySession.playerId=this.user.id;
        this.renderRoom();this.connectSocket();
    }
    closeSocket(){
        clearTimeout(this.reconnectTimer);this.reconnectTimer=null;this.reconnectDeadline=0;this.reconnectAttempt=0;
        this.socketReady=false;this.connectionVersion++;
        const ws=this.ws;this.ws=null;if(ws&&ws.readyState<2)ws.close(1000,"leave");
        this.banner("");
    }
    connectSocket(){
        if(!this.room||!this.token)return;
        const version=++this.connectionVersion;
        const url=new URL("/ws",this.base||location.origin);url.protocol=url.protocol==="https:"?"wss:":"ws:";
        const ws=this.ws=new WebSocket(url);this.socketReady=false;this.seq=0;
        const timer=setTimeout(()=>{if(version===this.connectionVersion&&!this.socketReady)ws.close(4008,"auth timeout");},7000);
        ws.addEventListener("open",()=>{if(version===this.connectionVersion)ws.send(JSON.stringify({type:"auth",token:this.token,room:this.room.code}));});
        ws.addEventListener("message",event=>{
            if(version!==this.connectionVersion)return;
            let msg;try{msg=JSON.parse(event.data);}catch(_){ws.close(1008,"bad response");return;}
            if(msg.type==="welcome"){
                clearTimeout(timer);this.socketReady=true;this.reconnectDeadline=0;this.reconnectAttempt=0;
                citySession.playerId=msg.player_id;this.banner("");this.status("room-status","На связи. Выезжай, когда будешь готов.");
                this.send({type:"ping",t:Date.now()});this.sendPose();
            }else if(msg.type==="state"){
                if(msg.room?.mode!=="city")return;
                this.room=msg.room;citySession.receive(msg);this.renderRoom();
            }else if(msg.type==="pong")this.latency=Math.max(0,Math.min(9999,Date.now()-msg.t));
            else if(msg.type==="horn"&&msg.player_id!==this.user?.id){
                citySession.horns.set(msg.player_id,performance.now()+650);
                const p=citySession.players().find(p=>p.id===msg.player_id);
                if(p&&Math.hypot(p.wx-game.wx,p.wy-game.wy)<1800&&!document.hidden)hornSound();
            }else if(msg.type==="error")this.status("room-status",msg.detail||"Диспетчер отклонил запрос.",true);
            else if(msg.type==="correction")this.status("room-status","Не удалось подтвердить позицию. Вернись в автопарк и начни новый рейс.",true);
        });
        ws.addEventListener("close",event=>{
            clearTimeout(timer);if(version!==this.connectionVersion)return;
            this.socketReady=false;this.ws=null;
            if(!this.room||!this.token)return;
            if([4001,4003,4004,4009,1008,1009].includes(event.code)){
                const message=event.code===4009?"Этот позывной уже подключён в другой вкладке.":"Войди в комнату снова. Твой рейс продолжается.";
                if(event.code===4001)this.expireSession();else{this.room=null;citySession.clear();this.renderRoom();}
                this.status("room-status",message,true);this.toast(message);return;
            }
            if(!this.reconnectDeadline)this.reconnectDeadline=Date.now()+18000;
            if(Date.now()>=this.reconnectDeadline){
                this.room=null;citySession.clear();this.renderRoom();this.banner("");
                this.toast("Связь с друзьями прервалась. Твой рейс продолжается; в комнату можно войти снова.");return;
            }
            this.banner("Восстанавливаем связь с друзьями…");
            this.reconnectTimer=setTimeout(()=>this.connectSocket(),Math.min(4000,500*2**this.reconnectAttempt++));
        });
        ws.addEventListener("error",()=>{});
    }
    banner(message){const b=this.el("network-banner");b.textContent=message;b.hidden=!message;}
    send(message){
        if(!this.ws||this.ws.readyState!==WebSocket.OPEN||!this.socketReady||this.ws.bufferedAmount>16384)return false;
        this.ws.send(JSON.stringify(message));return true;
    }
    sendPose(){
        if(!this.socketReady||this.room?.mode!=="city")return;
        if(citySession.pendingSpawn){if(!this.send({type:"spawn"}))return;citySession.pendingSpawn=false;}
        this.send({type:"pose",seq:++this.seq,...citySession.pose(game)});
    }
    broadcastHorn(){
        if(Date.now()-this.lastHorn<2100)return;
        if(this.send({type:"horn"}))this.lastHorn=Date.now();
    }
    async leaveRoom(){
        if(!this.room)return;
        const code=this.room.code;this.closeSocket();this.room=null;citySession.clear();this.renderRoom();
        try{await this.api("/api/rooms/"+code+"/leave",{method:"POST",body:{}});this.status("room-status","Ты покинул комнату. Свой рейс можно продолжить.");}
        catch(e){this.status("room-status",e.message,true);}
    }
    async copyInvite(){
        if(!this.room)return;
        const url=new URL(location.href);url.search="";url.hash="";url.searchParams.set("room",this.room.code);
        try{await navigator.clipboard.writeText(url.href);this.toast("Приглашение скопировано. Отправь его другу.");}
        catch(_){this.toast("Код для друзей: "+this.room.code);}
    }
    renderRoom(){
        this.el("room-browser").hidden=!!this.room;this.el("room-active").hidden=!this.room;
        this.el("online-count").hidden=!this.room;this.el("crew-strip").hidden=!this.room;
        if(this.room){
            this.el("active-room-code").textContent=this.room.code;this.el("active-room-name").textContent=this.room.name;
            this.el("online-count").textContent=this.room.count;
        }
        if(!this.room){this.lastRoster="";this.el("players-list").replaceChildren();this.el("crew-strip").replaceChildren();}
    }
    renderRoster(){
        if(!this.room)return;
        const players=this.room.players||[];
        const labels={intro:"В гараже",menu:"В гараже",dialog:"Инструктаж",play:"На линии",turning:"Поворот",pause:"Пауза",caught:"У ДПС",station:"В отделе",boom:"Авария",offer:"Ремонт",over:"Рейс окончен"};
        const rows=players.map(p=>({p,label:!p.connected?"Нет связи":p.id===this.user?.id?"Ты":labels[p.state]||"На связи"}));
        const key=JSON.stringify(rows.map(({p,label})=>[p.id,p.username,p.number,label]));
        if(key===this.lastRoster)return;this.lastRoster=key;
        const dot=p=>{const d=document.createElement("span");d.className="player-dot player-color-"+p.number;d.textContent=p.number;return d;};
        this.el("players-list").replaceChildren(...rows.map(({p,label})=>{
            const row=document.createElement("div");row.className="player-row"+(p.connected?"":" disconnected");
            const name=document.createElement("span");name.className="player-name";name.textContent=p.username;
            const state=document.createElement("small");state.textContent=label;row.append(dot(p),name,state);return row;
        }));
        this.el("crew-strip").replaceChildren(...rows.map(({p})=>{
            const chip=document.createElement("div");chip.className="crew-chip";
            const name=document.createElement("span");name.className="crew-name";name.textContent=p.username+(p.id===this.user?.id?" · ты":"");chip.append(dot(p),name);return chip;
        }));
    }
    async loadRooms(){
        if(this.room)return;const list=this.el("rooms-list");
        try{
            const data=await this.api("/api/rooms");const rooms=data.rooms.filter(r=>r.mode==="city");
            if(!rooms.length){const p=document.createElement("p");p.className="muted small";p.textContent="Пока никого. Создай комнату и позови своих.";list.replaceChildren(p);return;}
            list.replaceChildren(...rooms.map(r=>{
                const b=document.createElement("button");b.className="room-entry";b.type="button";b.disabled=r.count>=r.max_players;
                const name=document.createElement("span");name.textContent=r.name;
                const code=document.createElement("small");code.textContent=r.code;name.append(code);
                const count=document.createElement("span");count.textContent=r.count+" / "+r.max_players;
                b.append(name,count);b.addEventListener("click",()=>this.joinRoom(r.code));return b;
            }));
        }catch(_){const p=document.createElement("p");p.className="muted small";p.textContent="Комнаты появятся, когда восстановится связь.";list.replaceChildren(p);}
    }
}
window.app=new MarshrutkaApp();
