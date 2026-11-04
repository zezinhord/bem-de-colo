'use strict';

const STORAGE_KEY = 'bem-de-colo-v1';
const DEVICE_KEY = 'bem-de-colo-device-id';
const DEVICE_ID = localStorage.getItem(DEVICE_KEY) || (()=>{const id=(crypto&&crypto.randomUUID)?crypto.randomUUID():`${Date.now()}-${Math.random().toString(16).slice(2)}`;localStorage.setItem(DEVICE_KEY,id);return id;})();
const SUPABASE_CONFIG = window.BEM_DE_COLO_SUPABASE || {};
const supabaseClient = (window.supabase?.createClient && SUPABASE_CONFIG.url && SUPABASE_CONFIG.publishableKey)
  ? window.supabase.createClient(SUPABASE_CONFIG.url,SUPABASE_CONFIG.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}})
  : null;
let currentUser=null, currentFamily=null, realtimeChannel=null, cloudReady=false, applyingRemote=false, localDirty=false;
let activeStorageKey=STORAGE_KEY, syncTimer=null, syncInProgress=false, syncAgain=false, lastCloudUpdatedAt=null, authMode='signin', authBusy=false, familyBootstrapPromise=null;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const uid = () => (crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const todayKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const money = value => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(value)||0);
const dateLong = date => new Intl.DateTimeFormat('pt-BR',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(date);
const dateShort = date => new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'short'}).format(date);
const timeShort = date => new Intl.DateTimeFormat('pt-BR',{hour:'2-digit',minute:'2-digit'}).format(date);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

function defaultState(){
  return {
    version:1,
    baby:{name:'Meu bebê',birthDate:''},
    logs:[],
    inventory:[{id:uid(),name:'Fraldas',category:'hygiene',currentStock:0,dailyRate:8,leadTime:3,safetyDays:2,unit:'un',isDiaper:true}],
    goals:[],
    expenses:[],
    activeSleepId:null,
    settings:{dark:false}
  };
}
function loadState(storageKey=STORAGE_KEY){
  try{
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if(!saved || typeof saved !== 'object') return defaultState();
    const base = defaultState();
    return {
      ...base,...saved,
      baby:{...base.baby,...(saved.baby||{})},
      logs:Array.isArray(saved.logs)?saved.logs:[],
      inventory:Array.isArray(saved.inventory)?saved.inventory:base.inventory,
      goals:Array.isArray(saved.goals)?saved.goals:[],
      expenses:Array.isArray(saved.expenses)?saved.expenses:[],
      settings:{...base.settings,...(saved.settings||{})}
    };
  }catch(error){ console.warn('Não foi possível ler os dados locais.',error); return defaultState(); }
}
let state = loadState(STORAGE_KEY);
let modalHandler = null;
let toastTimer = null;

function saveState(sync=true){
  try{ localStorage.setItem(activeStorageKey,JSON.stringify(state)); }
  catch(error){ showToast('Não foi possível salvar. Verifique o espaço disponível no aparelho.'); console.error(error); }
  if(sync && currentFamily && !applyingRemote){
    localDirty=true;
    if(cloudReady)scheduleCloudSync();
    else setSyncStatus('Salvo neste celular · aguardando internet','offline');
  }
}
function setSyncStatus(message,kind='ok'){
  const el=$('#syncStatus');
  if(!el)return;
  el.textContent=message;
  el.classList.toggle('sync-offline',kind==='offline');
  el.classList.toggle('sync-error',kind==='error');
}
function scheduleCloudSync(delay=900){
  if(!cloudReady)return;
  clearTimeout(syncTimer);
  setSyncStatus(navigator.onLine?'Sincronização pendente':'Salvo neste celular · aguardando internet',navigator.onLine?'ok':'offline');
  syncTimer=setTimeout(pushCloudState,delay);
}
async function pushCloudState(){
  if(!cloudReady || !currentFamily || !currentUser)return;
  if(!navigator.onLine){setSyncStatus('Salvo neste celular · aguardando internet','offline');return;}
  if(syncInProgress){syncAgain=true;return;}
  syncInProgress=true;
  const snapshot=JSON.stringify(state);
  try{
    const {data,error}=await supabaseClient.from('family_state').upsert({
      family_id:currentFamily.id,
      payload:JSON.parse(snapshot),
      updated_by:currentUser.id,
      updated_device:DEVICE_ID
    },{onConflict:'family_id'}).select('updated_at').single();
    if(error)throw error;
    lastCloudUpdatedAt=data?.updated_at||lastCloudUpdatedAt;
    if(JSON.stringify(state)===snapshot){localDirty=false;setSyncStatus('Sincronizado agora','ok');}
    else{localDirty=true;syncAgain=true;}
  }catch(error){
    console.error('Falha na sincronização:',error);
    setSyncStatus('Erro ao sincronizar · dados preservados neste celular','error');
  }finally{
    syncInProgress=false;
    if(syncAgain){syncAgain=false;scheduleCloudSync(150);}
  }
}
function mergeArrayById(remoteItems=[],localItems=[]){
  const merged=new Map();
  (Array.isArray(remoteItems)?remoteItems:[]).forEach(item=>{if(item?.id)merged.set(item.id,item);});
  (Array.isArray(localItems)?localItems:[]).forEach(item=>{if(item?.id)merged.set(item.id,item);});
  return [...merged.values()];
}
function mergeStates(remoteState,localState){
  const remote=normalizeState(remoteState), local=normalizeState(localState);
  return {
    ...remote,...local,
    baby:{...remote.baby,...local.baby},
    settings:{...remote.settings,...local.settings},
    logs:mergeArrayById(remote.logs,local.logs),
    inventory:mergeArrayById(remote.inventory,local.inventory),
    goals:mergeArrayById(remote.goals,local.goals),
    expenses:mergeArrayById(remote.expenses,local.expenses),
    activeSleepId:local.activeSleepId||remote.activeSleepId||null
  };
}
function normalizeState(saved){
  const base=defaultState();
  if(!saved||typeof saved!=='object')return base;
  return {...base,...saved,baby:{...base.baby,...(saved.baby||{})},logs:Array.isArray(saved.logs)?saved.logs:[],inventory:Array.isArray(saved.inventory)?saved.inventory:base.inventory,goals:Array.isArray(saved.goals)?saved.goals:[],expenses:Array.isArray(saved.expenses)?saved.expenses:[],settings:{...base.settings,...(saved.settings||{})}};
}
function isNetworkFailure(error){return !navigator.onLine||/fetch|network|timeout|timed out|connection/i.test(String(error?.message||''));}
async function activateFamily(family,seedState=null){
  const sameFamily=!!currentFamily&&currentFamily.id===family.id;
  const hadPendingLocal=sameFamily&&localDirty;
  const retainedLocalState=seedState||state;
  cloudReady=false;currentFamily=family;
  if(realtimeChannel){await supabaseClient.removeChannel(realtimeChannel);realtimeChannel=null;}
  activeStorageKey=`bem-de-colo-family-${family.id}`;
  const localFamilyState=loadState(activeStorageKey);
  const hasLocalFamily=!!localStorage.getItem(activeStorageKey);
  if(currentUser)localStorage.setItem(`bem-de-colo-family-meta-${currentUser.id}`,JSON.stringify(family));
  let remoteRow=null;
  try{
    const {data,error}=await supabaseClient.from('family_state').select('payload,updated_at').eq('family_id',family.id).maybeSingle();
    if(error)throw error;
    remoteRow=data;
  }catch(error){
    if(!isNetworkFailure(error)||(!hasLocalFamily&&!seedState&&!hadPendingLocal))throw error;
    state=normalizeState(hasLocalFamily?localFamilyState:(seedState||retainedLocalState));cloudReady=false;localDirty=hadPendingLocal||!!seedState;
    applyingRemote=true;saveState(false);applyingRemote=false;
    renderAll();setSyncStatus('Offline · registros salvos neste celular','offline');
    return;
  }
  if(remoteRow){
    state=hadPendingLocal?mergeStates(remoteRow.payload,retainedLocalState):normalizeState(remoteRow.payload);
    lastCloudUpdatedAt=remoteRow.updated_at;
  }else{
    state=normalizeState(hasLocalFamily?localFamilyState:(seedState||defaultState()));
  }
  applyingRemote=true;saveState(false);applyingRemote=false;
  cloudReady=true;
  if(!remoteRow||hadPendingLocal){localDirty=true;await pushCloudState();}
  subscribeFamilyRealtime();
  renderAll();
  setSyncStatus(navigator.onLine?'Conectado à família':'Offline · sincroniza ao reconectar',navigator.onLine?'ok':'offline');
}
function subscribeFamilyRealtime(){
  if(!cloudReady||!currentFamily)return;
  if(realtimeChannel)supabaseClient.removeChannel(realtimeChannel);
  realtimeChannel=supabaseClient.channel(`family-state-${currentFamily.id}`)
    .on('postgres_changes',{event:'*',schema:'public',table:'family_state',filter:`family_id=eq.${currentFamily.id}`},payload=>{
      const row=payload.new;
      if(!row?.payload||row.updated_device===DEVICE_ID)return;
      if(row.updated_at&&lastCloudUpdatedAt&&new Date(row.updated_at)<=new Date(lastCloudUpdatedAt))return;
      const remote=normalizeState(row.payload);
      if(localDirty||syncInProgress){
        state=mergeStates(remote,state);
        saveState(false);localDirty=true;scheduleCloudSync(150);
      }else{
        applyingRemote=true;state=remote;saveState(false);applyingRemote=false;
        lastCloudUpdatedAt=row.updated_at||lastCloudUpdatedAt;renderAll();
        setSyncStatus('Atualizado pelo outro celular','ok');
      }
    })
    .subscribe(status=>{
      if(status==='SUBSCRIBED')setSyncStatus('Conectado à família','ok');
      if(status==='CHANNEL_ERROR'||status==='TIMED_OUT')setSyncStatus('Reconectando à nuvem…','offline');
    });
}
function showAuthStage(stage){
  $('#authGate').style.display='flex';
  $('#authAccess').hidden=stage!=='access';
  $('#familySetup').hidden=stage!=='setup';
  $('#familyConnected').hidden=stage!=='connected';
}
function setAuthMessage(message,element='#authMessage'){const target=$(element);if(target)target.textContent=message||'';}
function updateAuthMode(){
  const signup=authMode==='signup';
  $('#authTitle').textContent=signup?'Criar acesso privado.':'Cuidado compartilhado.';
  $('#authDescription').textContent=signup?'Cadastre seu e-mail e uma senha para entrar na conta familiar.':'Entre com seu e-mail e senha para acessar os registros sincronizados da família.';
  $('#authSubmit').textContent=signup?'Criar minha conta':'Entrar';
  $('#authPassword').autocomplete=signup?'new-password':'current-password';
  $('#authModeToggle').textContent=signup?'Já tem uma conta? Entrar':'Ainda não tem conta? Criar cadastro';
  setAuthMessage('');
}
async function loadUserFamily(user){
  if(!supabaseClient||!user)return;
  if(currentUser?.id===user.id && (currentFamily||$('#familySetup').hidden===false))return;
  if(familyBootstrapPromise)return familyBootstrapPromise;
  familyBootstrapPromise=(async()=>{
    currentUser=user;setAuthMessage('Verificando sua conta…');showAuthStage('access');
    let membership;
    try{
      const result=await supabaseClient.from('family_members').select('family_id,role').eq('user_id',user.id).maybeSingle();
      if(result.error)throw result.error;
      membership=result.data;
    }catch(error){
      const cached=localStorage.getItem(`bem-de-colo-family-meta-${user.id}`);
      if(!isNetworkFailure(error)||!cached)throw error;
      const family=JSON.parse(cached);
      await activateFamily(family);
      $('#authGate').style.display='none';
      return;
    }
    if(!membership){$('#familyMessage').textContent='';showAuthStage('setup');return;}
    const {data:family,error:familyError}=await supabaseClient.from('families').select('id,name,invite_code').eq('id',membership.family_id).single();
    if(familyError)throw familyError;
    await activateFamily(family);
    $('#authGate').style.display='none';
  })();
  try{return await familyBootstrapPromise;}finally{familyBootstrapPromise=null;}
}
function showConnectedFamily(family){
  $('#connectedFamilyName').textContent=family.name;
  $('#connectedInviteCode').textContent=family.invite_code;
  setAuthMessage('','#connectedMessage');
  showAuthStage('connected');
}
async function handleAuthSubmit(event){
  event.preventDefault();if(authBusy)return;
  if(!supabaseClient){setAuthMessage('Não foi possível carregar o Supabase. Verifique sua conexão com a internet e recarregue o aplicativo.');return;}
  const email=$('#authEmail').value.trim(),password=$('#authPassword').value;
  if(!email||password.length<8){setAuthMessage('Informe um e-mail válido e senha com pelo menos 8 caracteres.');return;}
  authBusy=true;$('#authSubmit').disabled=true;$('#authSubmit').textContent='Aguarde…';setAuthMessage('');
  try{
    if(authMode==='signup'){
      const {data,error}=await supabaseClient.auth.signUp({email,password,options:{emailRedirectTo:location.href.split('#')[0]}});
      if(error)throw error;
      if(data.session){await loadUserFamily(data.user);}
      else setAuthMessage('Cadastro iniciado. Confirme o e-mail recebido e depois entre no aplicativo.');
    }else{
      const {data,error}=await supabaseClient.auth.signInWithPassword({email,password});
      if(error)throw error;
      await loadUserFamily(data.user);
    }
  }catch(error){console.error(error);setAuthMessage(authErrorMessage(error));}
  finally{authBusy=false;$('#authSubmit').disabled=false;$('#authSubmit').textContent=authMode==='signup'?'Criar minha conta':'Entrar';}
}
function authErrorMessage(error){
  const message=String(error?.message||'');
  if(/invalid login credentials/i.test(message))return 'E-mail ou senha incorretos.';
  if(/email not confirmed/i.test(message))return 'Confirme seu e-mail antes de entrar.';
  if(/family_members|family_state|create_family|join_family|schema cache|does not exist/i.test(message))return 'O banco ainda não foi configurado. Execute o arquivo supabase/schema.sql no SQL Editor do projeto e tente novamente.';
  if(/fetch|network/i.test(message))return 'Falha de conexão. Verifique a internet e tente novamente.';
  return message||'Não foi possível concluir o acesso. Tente novamente.';
}
async function createFamily(event){
  event.preventDefault();const name=$('#familyName').value.trim();
  if(name.length<2){setAuthMessage('Informe um nome com pelo menos 2 caracteres.','#familyMessage');return;}
  const button=$('#createFamilyForm button');button.disabled=true;button.textContent='Criando…';setAuthMessage('','#familyMessage');
  try{
    const {data,error}=await supabaseClient.rpc('create_family',{p_name:name});if(error)throw error;
    await activateFamily(data,state);showConnectedFamily(data);
  }catch(error){console.error(error);setAuthMessage(authErrorMessage(error),'#familyMessage');}
  finally{button.disabled=false;button.textContent='Criar conta familiar';}
}
async function joinFamily(event){
  event.preventDefault();const code=$('#familyInviteCode').value.trim().toUpperCase();
  const button=$('#joinFamilyForm button');button.disabled=true;button.textContent='Conectando…';setAuthMessage('','#familyMessage');
  try{
    const {data:familyId,error}=await supabaseClient.rpc('join_family',{p_invite_code:code});if(error)throw error;
    const {data:family,error:familyError}=await supabaseClient.from('families').select('id,name,invite_code').eq('id',familyId).single();if(familyError)throw familyError;
    await activateFamily(family);$('#authGate').style.display='none';
  }catch(error){console.error(error);setAuthMessage(authErrorMessage(error),'#familyMessage');}
  finally{button.disabled=false;button.textContent='Entrar com convite';}
}
async function signOutFamily(){
  if(!supabaseClient)return;
  cloudReady=false;localDirty=false;
  if(realtimeChannel){await supabaseClient.removeChannel(realtimeChannel);realtimeChannel=null;}
  await supabaseClient.auth.signOut();
  currentUser=null;currentFamily=null;activeStorageKey=STORAGE_KEY;state=loadState(STORAGE_KEY);showAuthStage('access');$('#authGate').style.display='flex';
  setAuthMessage('Você saiu da conta familiar.');renderAll();
}
async function initializeFamilyAuth(){
  if(!supabaseClient){showAuthStage('access');setAuthMessage('O SDK ou a configuração do Supabase não carregou. Confirme a conexão e recarregue.');return;}
  supabaseClient.auth.onAuthStateChange((event,session)=>{
    if(session?.user){setTimeout(()=>loadUserFamily(session.user).catch(error=>{console.error(error);showAuthStage('access');setAuthMessage(authErrorMessage(error));}),0);}
    else if(event==='SIGNED_OUT'){cloudReady=false;currentUser=null;currentFamily=null;showAuthStage('access');}
  });
  const {data,error}=await supabaseClient.auth.getSession();if(error)throw error;
  if(data.session?.user)await loadUserFamily(data.session.user);else showAuthStage('access');
}
function openFamilyAccount(){
  if(!currentFamily)return;
  const html=`<div class="field full"><strong>${escapeHTML(currentFamily.name)}</strong><small class="field-hint">Conta familiar privada · ${escapeHTML(currentUser?.email||'')}</small></div><div class="field full"><label>Código de convite para o segundo responsável</label><input id="familyCodeModal" value="${escapeHTML(currentFamily.invite_code)}" readonly></div><div class="field full"><button type="button" class="outline-button" id="copyFamilyCodeModal">Copiar código</button><button type="button" class="mini-button danger-text" id="signOutFamilyModal">Sair da conta familiar</button></div><p class="small-copy">Registros, estoque, metas e despesas são compartilhados entre os integrantes desta família.</p>`;
  showModal('Conta familiar',html,()=>closeModal(),'Fechar');
  $('#copyFamilyCodeModal').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(currentFamily.invite_code);showToast('Código copiado.');}catch{showToast(`Código: ${currentFamily.invite_code}`);}});
  $('#signOutFamilyModal').addEventListener('click',async()=>{closeModal();await signOutFamily();});
}

function showToast(message){
  const toast=$('#toast'); toast.textContent=message; toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>toast.classList.remove('show'),3000);
}
function showModal(title, fields, onSave, submitLabel='Salvar'){
  $('#modalTitle').textContent=title; $('#modalFields').innerHTML=fields; $('#modalSubmit').textContent=submitLabel;
  modalHandler=onSave; $('#modalBackdrop').classList.add('open'); $('#modalBackdrop').setAttribute('aria-hidden','false');
  setTimeout(()=>$('#modalFields input, #modalFields select')?.focus(),60);
}
function closeModal(){ $('#modalBackdrop').classList.remove('open'); $('#modalBackdrop').setAttribute('aria-hidden','true'); modalHandler=null; $('#modalForm').reset(); }
function field(label,name,opts={}){
  const type=opts.type||'text', val=opts.value ?? '', placeholder=opts.placeholder||'', min=opts.min!==undefined?` min="${opts.min}"`:'', step=opts.step!==undefined?` step="${opts.step}"`:'', required=opts.required===false?'':' required', full=opts.full?' full':'';
  if(type==='select'){
    const options=(opts.options||[]).map(o=>`<option value="${escapeHTML(o.value)}" ${String(o.value)===String(val)?'selected':''}>${escapeHTML(o.label)}</option>`).join('');
    return `<div class="field${full}"><label for="f-${name}">${escapeHTML(label)}</label><select id="f-${name}" name="${name}"${required}>${options}</select>${opts.hint?`<small class="field-hint">${escapeHTML(opts.hint)}</small>`:''}</div>`;
  }
  return `<div class="field${full}"><label for="f-${name}">${escapeHTML(label)}</label><input id="f-${name}" name="${name}" type="${type}" value="${escapeHTML(val)}" placeholder="${escapeHTML(placeholder)}"${min}${step}${required} ${opts.max?`max="${opts.max}"`:''}>${opts.hint?`<small class="field-hint">${escapeHTML(opts.hint)}</small>`:''}</div>`;
}
function currentBabyName(){return state.baby.name?.trim() || 'Meu bebê';}
function categoryName(category){return ({hygiene:'Higiene',food:'Alimentação',health:'Saúde',clothing:'Vestuário',other:'Outros'})[category]||'Outros';}
function categoryIcon(category){return ({hygiene:'🧴',food:'🍼',health:'♡',clothing:'🧸',other:'✧'})[category]||'✧';}
function expenseCategoryFor(category){return ['hygiene','food','health','clothing'].includes(category)?category:'other';}
function inventoryForDiapers(){return state.inventory.find(item=>item.isDiaper || /fralda/i.test(item.name));}
function logsToday(){const today=todayKey();return state.logs.filter(log=>todayKey(new Date(log.timestamp))===today);}
function dailyRateFor(item){
  if(!(item.isDiaper || /fralda/i.test(item.name))) return Math.max(0,Number(item.dailyRate)||0);
  const cutoff=Date.now()-7*24*60*60*1000;
  const events=state.logs.filter(log=>log.type==='diaper' && new Date(log.timestamp).getTime()>=cutoff).length;
  return events>=7 ? events/7 : Math.max(0,Number(item.dailyRate)||8);
}
function reorderPoint(item){const rate=dailyRateFor(item), lead=Math.max(0,Number(item.leadTime)||0), safety=Math.max(0,Number(item.safetyDays)||0);return Math.ceil(rate*lead + rate*safety);}
function isLow(item){return Number(item.currentStock)<=reorderPoint(item);}
function monthsRemaining(deadline){
  if(!deadline) return 1;
  const end=new Date(`${deadline}T23:59:59`); const ms=end.getTime()-Date.now();
  if(ms<=0) return 0;
  return Math.max(1,Math.ceil(ms/(1000*60*60*24*30.4375)));
}
function monthlyContribution(goal){const gap=Math.max(0,Number(goal.targetAmount)-Number(goal.currentSaved));const months=monthsRemaining(goal.deadlineDate);return months===0?gap:gap/months;}
function goalProgress(goal){return Math.max(0,Math.min(100,(Number(goal.currentSaved)/Math.max(1,Number(goal.targetAmount)))*100));}
function expensesThisMonth(){const now=new Date();return state.expenses.filter(e=>{const d=new Date(`${e.date}T12:00:00`);return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();});}

function renderHeader(){
  const name=currentBabyName(); $('#babyNameTop').textContent=name; $('#avatarLetter').textContent=name.charAt(0).toUpperCase();
  const now=new Date(), hour=now.getHours();
  $('#greeting').textContent=hour<12?'Bom dia, família.':hour<18?'Que bom ter você por aqui.':'Boa noite. Um passo de cada vez.';
  $('#dateLabel').textContent=dateLong(now); $('#timelineDate').textContent=new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'long'}).format(now);
  $('#todayLabel').textContent=`SEU RESUMO DE ${new Intl.DateTimeFormat('pt-BR',{weekday:'long'}).format(now).toUpperCase()}`;
  $('#themeToggle').innerHTML=state.settings.dark?'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>':'<svg viewBox="0 0 24 24"><path d="M20.5 15.5A8.5 8.5 0 0 1 8.5 3.5 8.5 8.5 0 1 0 20.5 15.5Z"/></svg>';
  document.body.classList.toggle('theme-dark',!!state.settings.dark);
}
function renderStats(){
  const today=logsToday(), diapers=today.filter(l=>l.type==='diaper').length, feeds=today.filter(l=>l.type==='feeding').length;
  const sleepMinutes=today.filter(l=>l.type==='sleep'&&l.subtype==='ended').reduce((sum,l)=>sum+(Number(l.amount)||0),0);
  const sleepLabel=sleepMinutes>=60?`${Math.floor(sleepMinutes/60)}h${sleepMinutes%60?` ${sleepMinutes%60}m`:''}`:`${sleepMinutes} min`;
  $('#todayStats').innerHTML=`<div class="summary-card"><span class="stat-icon rose">♧</span><div class="stat-copy"><small>Trocas de fralda</small><strong>${diapers}</strong><span>hoje</span></div></div><div class="summary-card"><span class="stat-icon sage">♡</span><div class="stat-copy"><small>Alimentações</small><strong>${feeds}</strong><span>hoje</span></div></div><div class="summary-card"><span class="stat-icon blue">☾</span><div class="stat-copy"><small>Sono registrado</small><strong>${sleepMinutes?sleepLabel:'—'}</strong><span>hoje</span></div></div>`;
  $('#sleepActionTitle').textContent=state.activeSleepId?'Finalizar sono':'Começar sono';
  $('#sleepActionSub').textContent=state.activeSleepId?'encerrar esta soneca':'registrar uma soneca';
}
function logDescription(log){
  if(log.type==='diaper') return log.subtype==='dirty'?'Troca de fralda · suja':'Troca de fralda · molhada';
  if(log.type==='feeding'){
    const map={left_breast:'Leite materno · lado esquerdo',right_breast:'Leite materno · lado direito',both_breasts:'Leite materno · ambos os lados',formula:'Fórmula'};
    return map[log.subtype]||'Alimentação';
  }
  if(log.type==='sleep') return log.subtype==='started'?'Sono iniciado':`Soneca finalizada${log.amount?` · ${Math.floor(log.amount/60)}h${log.amount%60?` ${log.amount%60}min`:''}`:''}`;
  return 'Registro';
}
function renderTimeline(){
  const items=logsToday().sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp));
  if(!items.length){$('#timeline').innerHTML='<div class="empty-state"><span class="empty-symbol">☁</span>Nenhum registro por enquanto.<br>Quando algo acontecer, registre nos botões acima.</div>';return;}
  $('#timeline').innerHTML=items.map(log=>{
    const cls=log.type==='diaper'?'diaper':log.type==='feeding'?'feeding':'sleep';
    const icon=log.type==='diaper'?'♧':log.type==='feeding'?'♡':'☾';
    const extra=log.type==='feeding'&&log.amount?` · ${Number(log.amount)} ml`:'';
    return `<div class="timeline-item"><span class="timeline-dot ${cls}">${icon}</span><div class="timeline-info"><strong>${escapeHTML(logDescription(log))}${extra}</strong><small>${escapeHTML(new Intl.DateTimeFormat('pt-BR',{hour:'2-digit',minute:'2-digit'}).format(new Date(log.timestamp)))}</small></div><span class="timeline-time">${escapeHTML(timeShort(new Date(log.timestamp)))}</span></div>`;
  }).join('');
}
function renderStock(){
  const items=state.inventory; const low=items.filter(isLow); const totalUnits=items.reduce((s,i)=>s+Math.max(0,Number(i.currentStock)||0),0);
  $('#stockOverview').innerHTML=`<div class="overview-tile"><small>Itens cadastrados</small><strong>${items.length}</strong><span>no inventário</span></div><div class="overview-tile"><small>Precisam de atenção</small><strong class="${low.length?'danger-text':''}">${low.length}</strong><span>${low.length?'na lista de compras':'estoque em dia'}</span></div><div class="overview-tile"><small>Unidades em casa</small><strong>${totalUnits.toLocaleString('pt-BR')}</strong><span>somando os itens</span></div>`;
  $('#stockCount').textContent=`${items.length} ${items.length===1?'item':'itens'}`;
  $('#inventoryList').innerHTML=items.length?items.map(item=>{
    const rate=dailyRateFor(item), rop=reorderPoint(item), low=isLow(item), zeroDays=rate>0?Math.floor(Math.max(0,item.currentStock)/rate):null;
    return `<div class="inventory-row"><span class="item-icon">${categoryIcon(item.category)}</span><div class="item-main"><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(categoryName(item.category))} · consumo ${rate.toLocaleString('pt-BR',{maximumFractionDigits:1})}/${escapeHTML(item.unit||'un')} por dia</small><small>Ponto de reposição: ${rop} ${escapeHTML(item.unit||'un')}</small></div><div class="item-stock"><strong>${Number(item.currentStock).toLocaleString('pt-BR')}</strong><small>${escapeHTML(item.unit||'un')} disponíveis</small><span class="status-pill ${low?'low':''}">${low?'Estoque baixo':'Em dia'}</span></div><div class="item-actions"><button class="mini-button" data-stock-edit="${item.id}">Editar</button><button class="mini-button" data-stock-adjust="${item.id}">＋ Ajustar estoque</button>${zeroDays!==null?`<span class="small-copy">${zeroDays===0?'sem unidades':`aprox. ${zeroDays} dias de estoque`}</span>`:''}</div></div>`;
  }).join(''):'<div class="empty-stock">Seu inventário ainda está vazio.<br>Cadastre fraldas, lenços, fórmula e outros suprimentos.</div>';
  $('#shoppingCount').textContent=low.length;
  $('#shoppingList').innerHTML=low.length?low.map(item=>`<div class="shopping-item"><span class="item-icon">${categoryIcon(item.category)}</span><div class="item-main"><strong>${escapeHTML(item.name)}</strong><small>${Number(item.currentStock)} ${escapeHTML(item.unit||'un')} restantes · repor até ${reorderPoint(item)}</small></div><button data-buy="${item.id}">Marcar comprado</button></div>`).join(''):'<div class="empty-state"><span class="empty-symbol">✓</span>Nenhum item precisa ser reposto agora.</div>';
}
function ringSVG(percent,size=57){const r=22,c=2*Math.PI*r,offset=c*(1-Math.min(100,Math.max(0,percent))/100);return `<svg class="progress-ring" viewBox="0 0 56 56"><circle cx="28" cy="28" r="22" fill="none" stroke="var(--surface-2)" stroke-width="5"/><circle cx="28" cy="28" r="22" fill="none" stroke="var(--accent)" stroke-width="5" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${offset}" transform="rotate(-90 28 28)"/><text x="28" y="31" text-anchor="middle" font-size="10" font-weight="700" fill="var(--ink)">${Math.round(percent)}%</text></svg>`;}
function renderFinance(){
  const goals=state.goals; const saved=goals.reduce((s,g)=>s+(Number(g.currentSaved)||0),0);
  $('#totalSaved').textContent=money(saved); $('#goalCountLabel').textContent=`${goals.length} ${goals.length===1?'meta ativa':'metas ativas'}`;
  $('#goalsGrid').innerHTML=goals.length?goals.map(goal=>{
    const pct=goalProgress(goal), months=monthsRemaining(goal.deadlineDate), monthly=monthlyContribution(goal), deadline=goal.deadlineDate?new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'long',year:'numeric'}).format(new Date(`${goal.deadlineDate}T12:00:00`)):'Sem data limite';
    return `<article class="goal-card"><div class="goal-top"><span class="goal-icon">${escapeHTML(goal.icon||'✧')}</span><button class="goal-menu" title="Editar meta" data-goal-edit="${goal.id}">···</button></div><h4>${escapeHTML(goal.title)}</h4><span class="goal-deadline">${escapeHTML(deadline)}</span><div class="goal-progress-row">${ringSVG(pct)}<div class="goal-amount"><strong>${money(goal.currentSaved)}</strong><small>de ${money(goal.targetAmount)}</small></div></div><div class="goal-meta"><small>${months===0?'Prazo encerrado':`Aporte mensal sugerido`}</small><strong>${months===0?'—':money(monthly)}</strong></div><div class="goal-buttons"><button class="mini-button" data-goal-add="${goal.id}">＋ Guardar valor</button><button class="mini-button" data-goal-edit="${goal.id}">Editar</button></div></article>`;
  }).join(''):'<div class="panel empty-state" style="grid-column:1/-1"><span class="empty-symbol">✧</span>Você ainda não criou uma meta.<br>Comece com algo que deseja planejar para o bebê.</div>';
  const expenses=expensesThisMonth().sort((a,b)=>b.date.localeCompare(a.date)); const total=expenses.reduce((s,e)=>s+Number(e.amount||0),0);
  $('#expenseSummary').innerHTML=`<small>Total registrado neste mês</small><strong>${money(total)}</strong>`;
  $('#expenseList').innerHTML=expenses.length?expenses.slice(0,8).map(e=>`<div class="expense-row"><span class="expense-icon">${categoryIcon(e.category)}</span><div><strong>${escapeHTML(e.title)}</strong><small>${escapeHTML(categoryName(e.category))} · ${dateShort(new Date(`${e.date}T12:00:00`))}</small></div><span class="expense-value">${money(e.amount)}</span></div>`).join(''):'<div class="empty-state">Nenhuma despesa registrada neste mês.</div>';
}
function renderStockChart(){
  const item=inventoryForDiapers();
  if(!item){$('#stockChart').innerHTML='<div class="empty-state">Cadastre um item chamado “Fraldas” para visualizar a previsão de consumo.</div>';$('#stockChartFoot').innerHTML='';return;}
  const rate=dailyRateFor(item), stock=Math.max(0,Number(item.currentStock)||0), max=Math.max(10,Math.ceil(Math.max(stock,rate*7)/10)*10), width=540,height=180,left=38,right=10,top=14,bottom=30,plotW=width-left-right,plotH=height-top-bottom;
  const pts=[];for(let d=0;d<=7;d++){const v=Math.max(0,stock-rate*d);pts.push([left+d/7*plotW,top+(1-v/max)*plotH,v]);}
  const poly=pts.map(p=>`${p[0]},${p[1]}`).join(' ');const area=`${left},${top+plotH} ${poly} ${left+plotW},${top+plotH}`;
  const xLabels=[0,2,4,6,7].map(d=>`<text x="${left+d/7*plotW}" y="${height-7}" text-anchor="middle" font-size="9" fill="var(--muted)">${d===0?'Hoje':`+${d}d`}</text>`).join('');
  const yLabels=[0,.5,1].map(f=>`<g><line x1="${left}" y1="${top+f*plotH}" x2="${width-right}" y2="${top+f*plotH}" stroke="var(--line)" stroke-dasharray="3 4"/><text x="${left-8}" y="${top+f*plotH+3}" text-anchor="end" font-size="9" fill="var(--muted)">${Math.round(max*(1-f))}</text></g>`).join('');
  const zeroDays=rate>0?stock/rate:null;const zeroX=zeroDays!==null?left+Math.min(7,zeroDays)/7*plotW:null;
  $('#stockChart').innerHTML=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Projeção de consumo de fraldas nos próximos sete dias">${yLabels}<polygon points="${area}" fill="rgba(189,120,110,.12)"/><polyline points="${poly}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${pts.map((p,i)=>i===0||i===7?`<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>`:'' ).join('')}${zeroX!==null&&zeroDays<=7?`<line x1="${zeroX}" y1="${top}" x2="${zeroX}" y2="${top+plotH}" stroke="var(--danger)" stroke-dasharray="4 4"/><text x="${Math.min(width-48,Math.max(left+28,zeroX))}" y="${top+11}" text-anchor="middle" font-size="9" fill="var(--danger)">estoque zero</text>`:''}${xLabels}</svg>`;
  const zeroText=rate<=0?'defina o consumo diário':stock<=0?'sem unidades disponíveis':`estoque pode acabar em aproximadamente ${Math.ceil(zeroDays)} dia(s)`;
  $('#stockChartFoot').innerHTML=`<span>Estoque atual: <strong>${stock} ${escapeHTML(item.unit||'un')}</strong></span><span>Consumo: <strong>${rate.toLocaleString('pt-BR',{maximumFractionDigits:1})}/dia</strong> · ${escapeHTML(zeroText)}</span>`;
}
function renderExpenseChart(){
  const expenses=expensesThisMonth();const cats=['health','clothing','food','hygiene','other'];const colors={health:'#829eac',clothing:'#c39a60',food:'#7d9582',hygiene:'#bd786e',other:'#a59aaf'};
  const values=cats.map(cat=>({cat,value:expenses.filter(e=>e.category===cat).reduce((s,e)=>s+Number(e.amount||0),0)}));const total=values.reduce((s,v)=>s+v.value,0);let cursor=0;const segments=values.map(v=>{const start=cursor;cursor+=total? v.value/total*100:0;return `${colors[v.cat]} ${start}% ${cursor}%`;});
  const gradient=total?`conic-gradient(${segments.join(',')})`:'conic-gradient(var(--surface-2) 0% 100%)';
  const legend=values.filter(v=>v.value>0).map(v=>`<div class="legend-row"><span class="legend-dot" style="background:${colors[v.cat]}"></span><div>${categoryName(v.cat)}<strong>${money(v.value)}</strong></div></div>`).join('');
  $('#expenseChart').innerHTML=`<div class="donut" style="background:${gradient}"><div class="donut-center"><strong>${money(total)}</strong><small>neste mês</small></div></div><div class="legend">${legend||'<span class="small-copy">Registre despesas para visualizar a distribuição.</span>'}</div>`;
  $('#monthTag').textContent=new Intl.DateTimeFormat('pt-BR',{month:'short'}).format(new Date()).replace('.','').toUpperCase();
}
function renderMiniGoals(){
  $('#miniGoals').innerHTML=state.goals.length?state.goals.slice(0,6).map(g=>`<div class="mini-goal">${ringSVG(goalProgress(g))}<div><strong>${escapeHTML(g.title)}</strong><small>${money(g.currentSaved)} de ${money(g.targetAmount)}</small></div></div>`).join(''):'<div class="empty-state" style="grid-column:1/-1">Crie uma meta no Cofre para acompanhar seu progresso aqui.</div>';
}
function renderAll(){renderHeader();renderStats();renderTimeline();renderStock();renderFinance();renderStockChart();renderExpenseChart();renderMiniGoals();}

function addRoutineLog(type,subtype,amount=0){
  const log={id:uid(),type,subtype,amount:Number(amount)||0,timestamp:new Date().toISOString()};state.logs.push(log);
  if(type==='diaper'){
    const item=inventoryForDiapers();
    if(item){if(Number(item.currentStock)>0){item.currentStock=Number(item.currentStock)-1;showToast('Troca registrada. Uma fralda foi descontada do estoque.');}else{showToast('Troca registrada. O estoque de fraldas está zerado; atualize a quantidade.');}}
    else showToast('Troca registrada. Cadastre o item “Fraldas” no estoque para descontar automaticamente.');
  }else showToast('Registro adicionado à linha do tempo.');
  saveState();renderAll();
}
function openRoutineAction(action){
  if(action==='sleep'){
    if(state.activeSleepId){
      const started=state.logs.find(l=>l.id===state.activeSleepId);const minutes=started?Math.max(1,Math.round((Date.now()-new Date(started.timestamp).getTime())/60000)):0;
      state.logs.push({id:uid(),type:'sleep',subtype:'ended',amount:minutes,timestamp:new Date().toISOString()});state.activeSleepId=null;saveState();renderAll();showToast(`Sono finalizado. Duração: ${Math.floor(minutes/60)}h ${minutes%60}min.`);
    }else{
      const log={id:uid(),type:'sleep',subtype:'started',amount:0,timestamp:new Date().toISOString()};state.logs.push(log);state.activeSleepId=log.id;saveState();renderAll();showToast('Soneca iniciada. Toque novamente para finalizar.');
    }
    return;
  }
  if(action==='diaper'){
    showModal('Registrar troca de fralda',field('Tipo de troca','subtype',{type:'select',value:'wet',options:[{value:'wet',label:'Molhada'},{value:'dirty',label:'Suja'}],full:true}),data=>addRoutineLog('diaper',data.get('subtype')),'Registrar troca');
  }else if(action==='feeding'){
    const fields=field('Tipo de alimentação','subtype',{type:'select',value:'left_breast',options:[{value:'left_breast',label:'Leite materno · lado esquerdo'},{value:'right_breast',label:'Leite materno · lado direito'},{value:'both_breasts',label:'Leite materno · ambos os lados'},{value:'formula',label:'Fórmula'}],full:true})+field('Quantidade (ml, opcional)','amount',{type:'number',min:0,step:1,required:false,placeholder:'Ex.: 90',full:true});
    showModal('Registrar alimentação',fields,data=>addRoutineLog('feeding',data.get('subtype'),data.get('amount')),'Registrar alimentação');
  }
}

function openStockForm(item=null){
  const isEdit=!!item;const fields=field('Nome do produto','name',{value:item?.name||'',placeholder:'Ex.: Fraldas tamanho M',full:true})+
    field('Categoria','category',{type:'select',value:item?.category||'hygiene',options:[{value:'hygiene',label:'Higiene'},{value:'food',label:'Alimentação'},{value:'health',label:'Saúde'},{value:'clothing',label:'Vestuário'},{value:'other',label:'Outros'}]})+
    field('Unidade','unit',{value:item?.unit||'un',placeholder:'un, pacotes, latas...'})+
    field('Estoque atual','currentStock',{type:'number',min:0,step:1,value:item?.currentStock??0})+
    field('Consumo médio por dia','dailyRate',{type:'number',min:0,step:.1,value:item?.dailyRate??1,hint:'Usado na previsão quando ainda há poucos registros.'})+
    field('Prazo de entrega (dias)','leadTime',{type:'number',min:0,step:1,value:item?.leadTime??3})+
    field('Estoque de segurança (dias)','safetyDays',{type:'number',min:0,step:1,value:item?.safetyDays??2,hint:'Margem para atrasos ou aumento de consumo.'});
  showModal(isEdit?'Editar item do estoque':'Adicionar ao estoque',fields,data=>{
    const name=String(data.get('name')).trim();if(!name)return;
    const obj={name,category:data.get('category'),unit:String(data.get('unit')||'un').trim()||'un',currentStock:Math.max(0,Number(data.get('currentStock'))||0),dailyRate:Math.max(0,Number(data.get('dailyRate'))||0),leadTime:Math.max(0,Number(data.get('leadTime'))||0),safetyDays:Math.max(0,Number(data.get('safetyDays'))||0)};
    if(isEdit){Object.assign(item,obj);item.isDiaper=/fralda/i.test(item.name)||!!item.isDiaper;showToast('Item atualizado.');}
    else{state.inventory.push({id:uid(),...obj,isDiaper:/fralda/i.test(name)});showToast('Item adicionado ao inventário.');}
    saveState();renderAll();
  },isEdit?'Salvar alterações':'Adicionar item');
}
function adjustStock(item){
  showModal('Ajustar estoque',field('Quantidade a adicionar','quantity',{type:'number',min:1,step:1,value:1})+field('Motivo','reason',{type:'select',value:'purchase',options:[{value:'purchase',label:'Compra / reposição'},{value:'count',label:'Correção de contagem'},{value:'other',label:'Outro'}]}),data=>{
    item.currentStock=Math.max(0,Number(item.currentStock)+Number(data.get('quantity')));saveState();renderAll();showToast('Estoque atualizado.');
  },'Atualizar estoque');
}
function markPurchased(item){
  showModal(`Compra de ${item.name}`,field(`Quantidade adicionada (${item.unit||'un'})`,'quantity',{type:'number',min:1,step:1,value:1})+field('Valor total pago (R$)','amount',{type:'number',min:0,step:.01,placeholder:'0,00'})+field('Data da compra','date',{type:'date',value:todayKey()}),data=>{
    const qty=Math.max(1,Number(data.get('quantity'))||1), amount=Math.max(0,Number(data.get('amount'))||0);
    item.currentStock=Number(item.currentStock)+qty;
    if(amount>0)state.expenses.push({id:uid(),title:`Compra: ${item.name}`,amount,category:expenseCategoryFor(item.category),date:data.get('date')||todayKey(),source:'inventory'});
    saveState();renderAll();showToast(amount>0?'Estoque reposto e despesa registrada.':'Estoque reposto.');
  },'Confirmar compra');
}

function openGoalForm(goal=null){
  const editing=!!goal;
  const fields=field('Nome da meta','title',{value:goal?.title||'',placeholder:'Ex.: Cadeira para o carro',full:true})+
    field('Valor desejado (R$)','targetAmount',{type:'number',min:.01,step:.01,value:goal?.targetAmount??'',placeholder:'0,00'})+
    field('Já guardado (R$)','currentSaved',{type:'number',min:0,step:.01,value:goal?.currentSaved??0})+
    field('Data limite','deadlineDate',{type:'date',value:goal?.deadlineDate||'',full:true})+
    field('Ícone','icon',{type:'select',value:goal?.icon||'✧',options:[{value:'✧',label:'Estrela'},{value:'🍼',label:'Mamadeira'},{value:'🧸',label:'Ursinho'},{value:'🚗',label:'Carro'},{value:'🎂',label:'Comemoração'},{value:'♡',label:'Saúde'}],full:true});
  showModal(editing?'Editar meta':'Criar meta no Cofre',fields,data=>{
    const obj={title:String(data.get('title')).trim(),targetAmount:Math.max(.01,Number(data.get('targetAmount'))||.01),currentSaved:Math.max(0,Number(data.get('currentSaved'))||0),deadlineDate:data.get('deadlineDate'),icon:data.get('icon')};
    if(editing){Object.assign(goal,obj);showToast('Meta atualizada.');}else{state.goals.push({id:uid(),...obj});showToast('Meta criada.');}
    saveState();renderAll();
  },editing?'Salvar meta':'Criar meta');
}
function addToGoal(goal){
  showModal(`Guardar para ${goal.title}`,field('Valor do aporte (R$)','amount',{type:'number',min:.01,step:.01,placeholder:'0,00',full:true})+`<div class="field full"><small class="field-hint">Saldo atual: ${money(goal.currentSaved)} · Meta: ${money(goal.targetAmount)}</small></div>`,data=>{
    const amount=Math.max(0,Number(data.get('amount'))||0);if(!amount){showToast('Informe um valor maior que zero.');return;}
    goal.currentSaved=Number(goal.currentSaved)+amount;saveState();renderAll();showToast('Aporte adicionado à meta.');
  },'Guardar valor');
}
function openExpenseForm(){
  const fields=field('Descrição','title',{placeholder:'Ex.: Consulta pediátrica',full:true})+
    field('Valor (R$)','amount',{type:'number',min:.01,step:.01,placeholder:'0,00'})+
    field('Categoria','category',{type:'select',value:'health',options:[{value:'health',label:'Saúde'},{value:'clothing',label:'Vestuário'},{value:'food',label:'Alimentação'},{value:'hygiene',label:'Higiene'}]})+
    field('Data','date',{type:'date',value:todayKey()});
  showModal('Registrar despesa',fields,data=>{
    const amount=Number(data.get('amount'))||0;if(amount<=0){showToast('Informe um valor válido.');return;}
    state.expenses.push({id:uid(),title:String(data.get('title')).trim()||'Despesa',amount,category:data.get('category'),date:data.get('date')||todayKey()});saveState();renderAll();showToast('Despesa registrada.');
  },'Salvar despesa');
}
function editProfile(){
  showModal('Perfil do bebê',field('Nome','name',{value:state.baby.name,placeholder:'Nome do bebê',full:true})+field('Data de nascimento','birthDate',{type:'date',value:state.baby.birthDate||'',required:false,full:true}),data=>{
    state.baby.name=String(data.get('name')).trim()||'Meu bebê';state.baby.birthDate=data.get('birthDate')||'';saveState();renderAll();showToast('Perfil atualizado.');
  },'Salvar perfil');
}
function exportData(){
  const blob=new Blob([JSON.stringify({...state,exportedAt:new Date().toISOString()},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`bem-de-colo-dados-${todayKey()}.json`;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);showToast('Arquivo de dados exportado.');
}
function openPrivacy(){
  const cloudText=currentFamily
    ? `Os registros desta família são salvos neste aparelho e sincronizados com o Supabase. O acesso aos dados compartilhados é restrito aos usuários vinculados à família pelas políticas de segurança (RLS). Exporte uma cópia com cuidado: o arquivo pode conter dados pessoais e de rotina do bebê.`
    : 'Os registros deste aparelho ficam no armazenamento local até que você entre e conecte uma conta familiar.';
  showModal('Privacidade e dados',`<div class="field full"><p class="small-copy">${cloudText}</p><p class="small-copy">A chave publicável fica no aplicativo; nenhuma chave administrativa foi incluída. Nunca compartilhe senhas ou chaves secretas do projeto.</p><p class="small-copy">O armazenamento local usa o navegador e não possui criptografia própria em repouso. Mantenha o bloqueio de tela ativo e evite aparelhos compartilhados.</p></div><div class="field full"><button type="button" class="outline-button" id="privacyExport">Exportar meus dados</button></div>`,()=>closeModal(),'Fechar');
  $('#privacyExport').addEventListener('click',exportData);
}

function switchTab(tab){
  $$('.tab').forEach(button=>button.classList.toggle('active',button.dataset.tab===tab));
  $$('.view').forEach(view=>view.classList.toggle('active',view.id===`view-${tab}`));
  const titles={routine:'Rotina',stock:'Estoque',finance:'Cofre',analytics:'Gráficos'};document.title=`${titles[tab]||'Bem de Colo'} — Bem de Colo`;
  window.scrollTo({top:0,behavior:'smooth'});
}

// Navegação e ações principais
$$('.tab').forEach(button=>button.addEventListener('click',()=>switchTab(button.dataset.tab)));
$$('[data-action]').forEach(button=>button.addEventListener('click',()=>openRoutineAction(button.dataset.action)));
$('#closeModal').addEventListener('click',closeModal);$('#cancelModal').addEventListener('click',closeModal);
$('#modalBackdrop').addEventListener('click',event=>{if(event.target===$('#modalBackdrop'))closeModal();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeModal();});
$('#modalForm').addEventListener('submit',event=>{event.preventDefault();if(modalHandler){const handler=modalHandler;const data=new FormData(event.currentTarget);handler(data);if($('#modalBackdrop').classList.contains('open'))closeModal();}});
$('#themeToggle').addEventListener('click',()=>{state.settings.dark=!state.settings.dark;saveState();renderHeader();});
$('#profileButton').addEventListener('click',editProfile);$('#editBaby').addEventListener('click',editProfile);
$('#addStock').addEventListener('click',()=>openStockForm());$('#addGoal').addEventListener('click',()=>openGoalForm());$('#addExpense').addEventListener('click',openExpenseForm);
$('#exportData').addEventListener('click',exportData);$('#settingsButton').addEventListener('click',openPrivacy);$('#accountButton').addEventListener('click',openFamilyAccount);
$('#authForm').addEventListener('submit',handleAuthSubmit);$('#authModeToggle').addEventListener('click',()=>{authMode=authMode==='signin'?'signup':'signin';updateAuthMode();});$('#createFamilyForm').addEventListener('submit',createFamily);$('#joinFamilyForm').addEventListener('submit',joinFamily);$('#signOutFromSetup').addEventListener('click',signOutFamily);
$('#copyInviteCode').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(currentFamily.invite_code);setAuthMessage('Código copiado. Compartilhe somente com o segundo responsável.','#connectedMessage');}catch{setAuthMessage('Copie o código exibido manualmente.','#connectedMessage');}});
$('#enterAppButton').addEventListener('click',()=>{$('#authGate').style.display='none';renderAll();});
$('#miniGoals').addEventListener('click',event=>{if(event.target.closest('[data-goto]'))switchTab('finance');});

document.addEventListener('click',event=>{
  const editStock=event.target.closest('[data-stock-edit]');if(editStock){const item=state.inventory.find(i=>i.id===editStock.dataset.stockEdit);if(item)openStockForm(item);return;}
  const adjust=event.target.closest('[data-stock-adjust]');if(adjust){const item=state.inventory.find(i=>i.id===adjust.dataset.stockAdjust);if(item)adjustStock(item);return;}
  const buy=event.target.closest('[data-buy]');if(buy){const item=state.inventory.find(i=>i.id===buy.dataset.buy);if(item)markPurchased(item);return;}
  const addGoalButton=event.target.closest('[data-goal-add]');if(addGoalButton){const goal=state.goals.find(g=>g.id===addGoalButton.dataset.goalAdd);if(goal)addToGoal(goal);return;}
  const editGoalButton=event.target.closest('[data-goal-edit]');if(editGoalButton){const goal=state.goals.find(g=>g.id===editGoalButton.dataset.goalEdit);if(goal)openGoalForm(goal);return;}
  const goto=event.target.closest('[data-goto]');if(goto){switchTab(goto.dataset.goto);return;}
});

// PWA: o service worker só é registrado quando servido por HTTPS ou localhost.
if('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost')){
  window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(error=>console.warn('Service worker não registrado:',error)));
}
renderAll();
window.addEventListener('online',()=>{if(currentFamily&&currentUser&&!cloudReady){activateFamily(currentFamily,state).catch(error=>{console.error(error);setSyncStatus('Falha ao reconectar à nuvem','error');});}else if(cloudReady){if(localDirty)scheduleCloudSync(100);else setSyncStatus('Reconectado · verificando atualizações','ok');}});
window.addEventListener('offline',()=>{if(cloudReady)setSyncStatus('Offline · dados preservados neste celular','offline');});
initializeFamilyAuth().catch(error=>{console.error('Falha ao iniciar autenticação:',error);showAuthStage('access');setAuthMessage(authErrorMessage(error));});
