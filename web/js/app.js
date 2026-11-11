// Account and room UI. Session tokens never enter URLs, localStorage or sessionStorage.
"use strict";
class MarshrutkaApp {
    constructor() {
        this.mode="solo";this.token=null;this.user=null;this.room=null;this.ws=null;
        this.keys={up:false,down:false,left:false,right:false};this.authMode="login";
        this.seq=0;this.latency=null;this.healthy=false;this.reconnectTimer=null;
        this.reconnectDeadline=0;this.reconnectAttempt=0;this.connectionVersion=0;
        this.socketReady=false;this.stopRequested=false;this.lastHorn=0;this.lastRoster="";
        this.lastStatus=null;this.pendingCode=null;this.toastTimer=null;this.roomRequest=false;
        this.base=(window.MARSHRUTKA_CONFIG?.API_BASE||"").trim().replace(/\/+$/,"");
        if(this.base){try{const u=new URL(this.base);if(!["http:","https:"].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error();this.base=u.origin;}catch(_){this.base="";this.badConfig=true;}}
        this.bind();this.health();
        setInterval(()=>this.sendInput(),50);
        setInterval(()=>{if(this.socketReady)this.send({type:"ping",t:Date.now()});},10000);
        setInterval(()=>{if(this.mode==="online"&&!this.room&&this.healthy)this.loadRooms();},15000);
        const code=new URLSearchParams(location.search).get("room");
        if(code&&/^[A-Z2-9]{6}$/i.test(code)){this.pendingCode=code.toUpperCase();this.el("room-code").value=this.pendingCode;this.setMode("online");this.status("room-status","Приглашение открыто. Войди, чтобы присоединиться.");}
    }
    el(id){return document.getElementById(id);}
    status(id,message,error=false){const e=this.el(id);e.textContent=message;e.classList.toggle("error",error);}
    toast(message){const e=this.el("toast");e.textContent=message;e.hidden=false;clearTimeout(this.toastTimer);this.toastTimer=setTimeout(()=>e.hidden=true,4200);}
    bind(){
        document.querySelectorAll("[data-mode]").forEach(b=>b.addEventListener("click",()=>this.setMode(b.dataset.mode)));
        this.el("show-login").addEventListener("click",()=>this.authTab("login"));
        this.el("show-register").addEventListener("click",()=>this.authTab("register"));
        this.el("toggle-password").addEventListener("click",()=>{const p=this.el("password"),show=p.type==="password";p.type=show?"text":"password";this.el("toggle-password").setAttribute("aria-label",show?"Скрыть пароль":"Показать пароль");});
        this.el("auth-form").addEventListener("submit",e=>{e.preventDefault();this.authenticate();});
        this.el("logout").addEventListener("click",()=>this.logout());
        this.el("retry-server").addEventListener("click",()=>this.health());
        this.el("refresh-leaders").addEventListener("click",()=>this.loadLeaders());
        this.el("refresh-rooms").addEventListener("click",()=>this.loadRooms());
        this.el("create-room-form").addEventListener("submit",e=>{e.preventDefault();this.createRoom();});
        this.el("join-room-form").addEventListener("submit",e=>{e.preventDefault();this.joinRoom(this.el("room-code").value);});
        this.el("room-start").addEventListener("click",()=>{this.status("room-status","");this.send({type:"start"});canvas.focus({preventScroll:true});});
        this.el("room-leave").addEventListener("click",()=>this.leaveRoom());
        this.el("copy-room").addEventListener("click",()=>this.copyInvite());
        this.el("solo-start").addEventListener("click",()=>{
            this.setMode("solo");
            if(["menu","intro","over"].includes(game.state))game.startRun();
            else if(game.state==="pause")game.togglePause();
            else this.toast("Рейс уже идёт. Продолжай за рулём.");
            canvas.focus({preventScroll:true});
        });
        document.addEventListener("focusin",e=>{if(isTextControl(e.target))releaseKeys();});
    }
    setMode(mode){
        if(!["solo","online","leaders"].includes(mode))return;
        releaseKeys();this.mode=mode;
        document.querySelectorAll("[data-mode]").forEach(b=>{const active=b.dataset.mode===mode;b.classList.toggle("active",active);b.setAttribute("aria-pressed",String(active));});
        this.el("leaderboard-view").hidden=mode!=="leaders";canvas.hidden=mode==="leaders";
        document.querySelector(".controls").hidden=mode==="leaders";
        this.el("solo-card").hidden=mode!=="solo";this.el("online-card").hidden=mode!=="online";
        this.el("result-card").hidden=mode!=="online"||this.room?.status!=="finished";
        this.el("stage-title").textContent={solo:"Маршрут № 480",online:"Вместе по Иркутску",leaders:"Водители города"}[mode];
        this.el("stage-eyebrow").textContent={solo:"ТВОЯ СМЕНА",online:"ОДИН ГОРОД — ОБЩИЙ РЕЙС",leaders:"ЧЕСТНЫЕ РЕЗУЛЬТАТЫ"}[mode];
        const pill=this.el("mode-pill");pill.replaceChildren();const dot=document.createElement("span");dot.className="dot";pill.append(dot,document.createTextNode({solo:"ОДИНОЧНЫЙ",online:"МУЛЬТИПЛЕЕР",leaders:"РЕЙТИНГ"}[mode]));
        this.el("stage-caption").textContent={solo:"Твой город. Твой темп.",online:"Встречаемся на одной дороге.",leaders:"Каждая остановка имеет значение."}[mode];
        this.el("driving-tip").textContent=mode==="online"?"В правый карман, затем полный тормоз. Посадка занимает 1,5 секунды. Пассажиры общие — помогайте друг другу!":"Заезжай в карман жёлтой остановки и остановись. Пассажиры сядут сами.";
        if(mode==="online"){this.loadRooms();if(!this.token)this.status("room-status","Для сетевой игры войди или зарегистрируйся.");}
        if(mode==="leaders")this.loadLeaders();
        this.el("network-banner").hidden=mode!=="online"||!this.el("network-banner").textContent;
    }
    authTab(mode){
        this.authMode=mode;this.el("show-login").classList.toggle("selected",mode==="login");this.el("show-register").classList.toggle("selected",mode==="register");
        this.el("password").autocomplete=mode==="login"?"current-password":"new-password";
        this.el("auth-submit").textContent=mode==="login"?"Войти за руль →":"Получить удостоверение →";
        this.status("auth-status","");
    }
    async api(path,options={}){
        const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),10000);
        try{
            const headers={Accept:"application/json",...(options.body!==undefined?{"Content-Type":"application/json"}:{}),...(this.token?{Authorization:`Bearer ${this.token}`}:{})};
            const response=await fetch(this.base+path,{method:options.method||"GET",headers,body:options.body!==undefined?JSON.stringify(options.body):undefined,credentials:"omit",signal:controller.signal,cache:"no-store"});
            let data;try{data=await response.json();}catch(_){throw new Error("Сервер вернул неверный ответ. Проверь адрес API в config/runtime.js.");}
            if(!response.ok){
                const detail=typeof data.detail==="string"?data.detail:response.status===422?"Проверь введённые данные: позывной, пароль или код комнаты.":`Ошибка сервера (${response.status}). Попробуй позже.`;
                if(response.status===401&&this.token)this.expireSession();
                throw new Error(detail);
            }
            return data;
        }catch(error){
            if(error.name==="AbortError")throw new Error("Сервер долго не отвечает. Проверь подключение и попробуй ещё раз.");
            if(error instanceof TypeError)throw new Error(location.protocol==="file:"?"Открой игру через сервер FastAPI, чтобы включить сетевые функции.":"Нет связи с сервером. Одиночная игра доступна; для сети нужен работающий API.");
            throw error;
        }finally{clearTimeout(timeout);}
    }
    async health(){
        this.el("retry-server").hidden=true;
        try{
            if(this.badConfig)throw new Error("Проверь API_BASE в config/runtime.js");
            const data=await this.api("/api/health");if(!data.ok||data.protocol!==1)throw new Error("Несовместимая версия сервера");
            this.healthy=true;this.el("server-led").className="status-led online";this.el("server-status").textContent="Диспетчер на связи · сервер доступен";
        }catch(_){this.healthy=false;this.el("server-led").className="status-led offline";this.el("server-status").textContent=this.badConfig?"Проверь адрес API в config/runtime.js":"Сервер недоступен · одиночная игра работает";this.el("retry-server").hidden=false;}
    }
    async authenticate(){
        const button=this.el("auth-submit");if(button.disabled)return;
        button.disabled=true;this.status("auth-status",this.authMode==="register"?"Оформляем удостоверение…":"Проверяем удостоверение…");
        try{
            const result=await this.api(`/api/auth/${this.authMode}`,{method:"POST",body:{username:this.el("username").value.trim(),password:this.el("password").value}});
            this.token=result.token;this.user=result.user;this.el("password").value="";this.showUser();this.status("auth-status","Готово. Добро пожаловать на линию!");
            if(this.pendingCode){const code=this.pendingCode;this.pendingCode=null;await this.joinRoom(code);}else{this.status("room-status","");if(this.mode==="online")this.loadRooms();}
            this.health();
        }catch(error){this.status("auth-status",error.message,true);}
        finally{button.disabled=false;}
    }
    showUser(){
        this.el("auth-guest").hidden=!!this.user;this.el("auth-user").hidden=!this.user;
        this.el("driver-name").textContent=this.user?.username||"";this.el("driver-avatar").textContent=(this.user?.username||"И").slice(0,1).toUpperCase();
    }
    expireSession(){
        this.closeSocket();this.token=null;this.user=null;this.room=null;onlineView.reset();this.showUser();this.renderRoom();
        this.status("auth-status","Сессия закончилась. Войди снова.",true);
    }
    async logout(){
        const b=this.el("logout");if(b.disabled)return;b.disabled=true;
        try{if(this.room)await this.leaveRoom();await this.api("/api/auth/logout",{method:"POST",body:{}});this.status("auth-status","Ты вышел из аккаунта.");}
        catch(error){this.status("auth-status",error.message,true);}
        finally{this.closeSocket();this.token=null;this.user=null;this.room=null;onlineView.reset();this.showUser();this.renderRoom();b.disabled=false;}
    }
    requireUser(){
        if(this.token)return true;
        this.status("room-status","Сначала войди в блоке «Удостоверение водителя».",true);
        this.el("username").focus();return false;
    }
    async createRoom(){
        if(!this.requireUser()||this.roomRequest)return;
        this.roomRequest=true;const button=this.el("create-room-form").querySelector("button");button.disabled=true;this.status("room-status","Создаём комнату…");
        try{const data=await this.api("/api/rooms",{method:"POST",body:{name:this.el("room-name").value.trim(),public:!this.el("room-private").checked,max_players:Number(this.el("room-max-players").value)}});this.enterRoom(data.room);}
        catch(error){this.status("room-status",error.message,true);}
        finally{this.roomRequest=false;button.disabled=false;}
    }
    async joinRoom(raw){
        const code=String(raw).trim().toUpperCase();
        if(!this.requireUser()){this.pendingCode=code;return;}
        if(this.roomRequest)return;
        if(!/^[A-Z2-9]{6}$/.test(code)){this.status("room-status","Введи код комнаты латинскими буквами и цифрами.",true);return;}
        this.roomRequest=true;this.status("room-status","Присоединяемся к рейсу…");
        try{const data=await this.api(`/api/rooms/${encodeURIComponent(code)}/join`,{method:"POST",body:{}});this.enterRoom(data.room);}
        catch(error){this.status("room-status",error.message,true);}
        finally{this.roomRequest=false;}
    }
    enterRoom(room){
        this.closeSocket();this.room=room;this.lastStatus=null;this.lastRoster="";onlineView.reset();onlineView.playerId=this.user.id;
        this.renderRoom();this.setMode("online");this.status("room-status","Соединяемся с комнатой…");this.connectSocket();
    }
    closeSocket(){
        clearTimeout(this.reconnectTimer);this.reconnectTimer=null;this.reconnectDeadline=0;this.reconnectAttempt=0;this.socketReady=false;this.connectionVersion++;
        const ws=this.ws;this.ws=null;if(ws&&ws.readyState<2)ws.close(1000,"leave");
        this.banner("");releaseKeys();
    }
    connectSocket(){
        if(!this.room||!this.token)return;
        const version=++this.connectionVersion;
        const url=new URL("/ws",this.base||location.origin);url.protocol=url.protocol==="https:"?"wss:":"ws:";
        let ws;try{ws=new WebSocket(url);}catch(_){this.status("room-status","Не удалось открыть WebSocket. Проверь адрес API.",true);return;}
        this.ws=ws;this.socketReady=false;this.seq=0;
        const authTimer=setTimeout(()=>{if(version===this.connectionVersion&&!this.socketReady)ws.close(4008,"auth timeout");},7000);
        ws.addEventListener("open",()=>{if(version!==this.connectionVersion)return;ws.send(JSON.stringify({type:"auth",token:this.token,room:this.room.code}));});
        ws.addEventListener("message",event=>{
            if(version!==this.connectionVersion)return;
            let msg;try{msg=JSON.parse(event.data);}catch(_){ws.close(1008,"bad response");return;}
            if(msg.type==="welcome"){
                clearTimeout(authTimer);this.socketReady=true;this.reconnectDeadline=0;this.reconnectAttempt=0;onlineView.playerId=msg.player_id;
                this.banner("");this.status("room-status","Связь установлена.");this.send({type:"ping",t:Date.now()});this.renderRoom();
            }else if(msg.type==="state"){
                this.room=msg.room;onlineView.receive(msg);this.renderRoom(msg);
                if(msg.room.status!==this.lastStatus){
                    this.lastStatus=msg.room.status;
                    if(msg.room.status==="running"){releaseKeys();this.stopRequested=false;this.status("room-status","Вы на линии. Удачной смены!");canvas.focus({preventScroll:true});}
                    if(msg.room.status==="finished"){releaseKeys();this.renderResults(msg.results||[]);this.loadLeaders();}
                }
            }else if(msg.type==="error")this.status("room-status",msg.detail||"Операция отклонена сервером.",true);
            else if(msg.type==="pong")this.latency=Math.max(0,Math.min(9999,Date.now()-msg.t));
            else if(msg.type==="horn"){onlineView.horns.set(msg.player_id,performance.now()+600);if(this.mode==="online"&&!document.hidden)hornSound();}
        });
        ws.addEventListener("close",event=>{
            clearTimeout(authTimer);if(version!==this.connectionVersion)return;
            this.socketReady=false;this.ws=null;releaseKeys();this.renderRoom();
            if(!this.room||!this.token)return;
            if([4001,4003,4004,4009,1008,1009].includes(event.code)){
                const message={4001:"Сессия закончилась. Войди снова.",4003:"Доступ к комнате закрыт.",4004:"Комната уже закрыта. Создай новую.",4009:"Этот аккаунт уже подключён в другом окне.",1008:"Сервер закрыл соединение: неверные данные.",1009:"Сервер закрыл слишком большое сообщение."}[event.code];
                if(event.code===4001)this.expireSession();else{this.room=null;onlineView.reset();this.renderRoom();}
                this.status("room-status",message,true);this.banner("");return;
            }
            if(!this.reconnectDeadline)this.reconnectDeadline=Date.now()+18000;
            if(Date.now()>=this.reconnectDeadline){this.room=null;onlineView.reset();this.renderRoom();this.banner("");this.status("room-status","Связь не восстановилась. Войди в комнату снова.",true);return;}
            this.banner("Потеряна связь. Восстанавливаем подключение…");
            const delay=Math.min(4000,750*2**this.reconnectAttempt++);
            this.reconnectTimer=setTimeout(()=>this.connectSocket(),delay);
        });
        ws.addEventListener("error",()=>{/* close handles the bounded reconnect flow */});
    }
    banner(message){const b=this.el("network-banner");b.textContent=message;b.hidden=!message||this.mode!=="online";}
    send(message){if(!this.ws||this.ws.readyState!==WebSocket.OPEN||!this.socketReady)return false;if(this.ws.bufferedAmount>65536)return false;this.ws.send(JSON.stringify(message));return true;}
    sendInput(force=false){
        if(!this.socketReady||(!force&&this.room?.status!=="running"))return;
        const active=this.mode==="online"&&!document.hidden;
        const moving=active?this.keys:{up:false,down:true,left:false,right:false};
        if(this.keys.up)this.stopRequested=false;
        this.send({type:"input",seq:++this.seq,up:!!moving.up,down:!!moving.down||this.stopRequested,left:!!moving.left,right:!!moving.right});
    }
    stopBus(){releaseKeys();this.stopRequested=true;this.sendInput(true);this.toast("Тормозим. Общий рейс продолжается — паузы в сети нет.");}
    honk(){if(!this.socketReady||this.room?.status!=="running"||Date.now()-this.lastHorn<2100)return;this.lastHorn=Date.now();this.send({type:"horn"});}
    async leaveRoom(){
        if(!this.room)return;const code=this.room.code;this.closeSocket();this.room=null;onlineView.reset();this.renderRoom();
        try{await this.api(`/api/rooms/${encodeURIComponent(code)}/leave`,{method:"POST",body:{}});this.status("room-status","Ты покинул комнату.");}
        catch(error){this.status("room-status",error.message,true);}
        this.loadRooms();
    }
    async copyInvite(){
        if(!this.room)return;const url=new URL(location.href);url.search="";url.hash="";url.searchParams.set("room",this.room.code);
        try{await navigator.clipboard.writeText(url.href);this.toast("Ссылка приглашения скопирована.");}
        catch(_){this.status("room-status",`Код приглашения: ${this.room.code}. Передай его другу.`);this.toast(`Код комнаты: ${this.room.code}`);}
    }
    renderRoom(state){
        this.el("room-browser").hidden=!!this.room;this.el("room-active").hidden=!this.room;
        this.el("result-card").hidden=this.mode!=="online"||this.room?.status!=="finished";
        if(!this.room){this.lastRoster="";return;}
        this.el("active-room-code").textContent=this.room.code;this.el("active-room-name").textContent=this.room.name;
        const host=this.room.host_id===this.user?.id;const waiting=["waiting","finished"].includes(this.room.status);
        this.el("room-start").hidden=!host;this.el("room-start").disabled=!waiting||!this.socketReady;
        this.el("room-start").textContent=this.room.status==="finished"?"Ещё один рейс →":"Начать общий рейс →";
        this.el("room-state-note").textContent=waiting?(host?"Можно начать одному или дождаться друзей.":"Дождись, пока создатель комнаты начнёт рейс."):this.room.status==="countdown"?"Смена начинается. Приготовься!":"Общий рейс идёт. После обрыва есть 20 секунд на возврат.";
        const players=state?.players||this.room.players||[];
        const signature=JSON.stringify(players.map(p=>[p.id,p.username,p.connected,p.score,p.color]))+this.room.host_id;
        if(signature===this.lastRoster)return;this.lastRoster=signature;
        this.el("players-list").replaceChildren(...players.map(p=>{
            const row=document.createElement("div");row.className="player-row"+(p.connected?"":" disconnected");
            const palette=["#f5c81e","#59cbe8","#e798ff","#8fe388","#ff9578","#9daaff","#f2a5c6","#faf5dd"];
            const colorIndex=Math.max(0,palette.indexOf(String(p.color||"").toLowerCase()));
            const swatch=document.createElement("span");swatch.className=`player-swatch player-color-${colorIndex}`;
            const name=document.createElement("span");name.className="player-name";name.textContent=p.username+(p.id===this.user?.id?" · ты":"");
            const mark=document.createElement("small");mark.textContent=!p.connected?"нет связи":this.room.status==="running"?`${p.score||0} ₽`:p.id===this.room.host_id?"ведущий":"на линии";
            row.append(swatch,name,mark);return row;
        }));
    }
    renderResults(results){
        this.el("result-card").hidden=this.mode!=="online";
        this.el("round-results").replaceChildren(...results.slice().sort((a,b)=>b.score-a.score).map((r,index)=>{
            const row=document.createElement("div");row.className="result-row";
            const rank=document.createElement("span");rank.className="result-rank";rank.textContent=String(index+1).padStart(2,"0");
            const name=document.createElement("span");name.textContent=r.username;
            const score=document.createElement("strong");score.textContent=`${r.score} ₽`;
            row.append(rank,name,score);return row;
        }));
        const own=results.find(r=>r.id===this.user?.id);
        this.el("result-note").textContent=own?.qualified?"Твой результат сохранён. Лучший рейс попадёт в общий рейтинг.":"Для зачёта в рейтинге нужно обслужить хотя бы одну остановку за завершённую смену.";
    }
    async loadRooms(){
        if(this.room)return;
        const list=this.el("rooms-list");
        try{
            const data=await this.api("/api/rooms");
            if(!data.rooms?.length){const p=document.createElement("p");p.className="muted small";p.textContent="Пока нет открытых комнат. Создай первую!";list.replaceChildren(p);return;}
            list.replaceChildren(...data.rooms.map(room=>{
                const b=document.createElement("button");b.className="room-entry";b.type="button";b.disabled=!["waiting","finished"].includes(room.status)||room.count>=room.max_players;
                const title=document.createElement("span");title.textContent=room.name;
                const detail=document.createElement("small");detail.textContent=`${room.code} · ${room.status==="running"?"уже на линии":room.status==="countdown"?"стартуют":"ожидание"}`;title.append(detail);
                const count=document.createElement("span");count.textContent=`${room.count}/${room.max_players}`;
                b.append(title,count);b.addEventListener("click",()=>this.joinRoom(room.code));return b;
            }));
        }catch(_){const p=document.createElement("p");p.className="muted small";p.textContent="Список комнат появится после подключения к серверу.";list.replaceChildren(p);}
    }
    async loadLeaders(){
        const message=this.el("leaders-message"),button=this.el("refresh-leaders");button.disabled=true;
        message.textContent="Загружаем рейтинг…";message.hidden=false;this.el("leaderboard-table").hidden=true;
        try{
            const data=await this.api("/api/leaderboard?limit=30");const entries=data.entries||[];
            if(!entries.length){message.textContent="Здесь пока тихо. Заверши сетевую смену, обслужи хотя бы одну остановку — и открой рейтинг города.";return;}
            this.el("leaderboard-body").replaceChildren(...entries.map(e=>{
                const row=document.createElement("tr");if(e.username===this.user?.username)row.className="current-user";
                [e.rank,e.username,`${e.score.toLocaleString("ru-RU")} ₽`,e.stops].forEach((v,i)=>{const td=document.createElement("td");td.textContent=String(v);if(i===0)td.className=e.rank<=3?"rank rank-top":"rank";row.append(td);});return row;
            }));message.hidden=true;this.el("leaderboard-table").hidden=false;
        }catch(error){message.textContent=error.message;}
        finally{button.disabled=false;}
    }
}
window.app=new MarshrutkaApp();
