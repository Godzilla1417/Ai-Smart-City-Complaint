/* CivicFlow client state. The JSON records mirror citizen, complaint and department rows. */
const STORAGE={complaints:'civicflow.complaints.v1',users:'civicflow.users.v1',session:'civicflow.session.v1'};
const departments=['Public Works','Environmental Services','Street Services','Water Utilities','Parks & Recreation'];
const seedComplaints=[];
const legacyDemoIds=new Set(['CF-719302','CF-482165','CF-305874','CF-861049','CF-195438','CF-647211']);
const state={complaints:loadJSON(STORAGE.complaints,seedComplaints).filter(record=>!legacyDemoIds.has(record.id)),users:loadJSON(STORAGE.users,[]),session:loadJSON(STORAGE.session,null),route:'home',authMode:'login',charts:{}};
const sharedApiEnabled=location.protocol==='https:'&&!['localhost','127.0.0.1'].includes(location.hostname);

// ── Leaflet map instances ────────────────────────────────────────────────────
let submitMap=null, submitMarker=null, submitMapProvider='osm', googleGeocoder=null, googleMapsLoadPromise=null;
let adminLMap=null, adminLMarkers=[];
let dispatchVehicleIcon=null, dispatchDestIcon=null;
let dispatchVehicleLat=null, dispatchVehicleLng=null;
// ── Shared selected location for submit form ─────────────────────────────────
const selectedLocation={latitude:null,longitude:null,address:''};
let nominatimQueue=Promise.resolve(),nominatimLastRequest=0;
function fetchNominatim(url){
  const request=nominatimQueue.then(async()=>{
    const pause=Math.max(0,1100-(Date.now()-nominatimLastRequest));
    if(pause)await new Promise(resolve=>setTimeout(resolve,pause));
    nominatimLastRequest=Date.now();
    return fetch(url,{headers:{'Accept-Language':'en'}});
  });
  nominatimQueue=request.catch(()=>{});
  return request;
}
function loadJSON(key,fallback){try{const value=JSON.parse(localStorage.getItem(key));return value??structuredClone(fallback)}catch{return structuredClone(fallback)}}
function persist(){localStorage.setItem(STORAGE.complaints,JSON.stringify(state.complaints));localStorage.setItem(STORAGE.users,JSON.stringify(state.users));if(state.session)localStorage.setItem(STORAGE.session,JSON.stringify(state.session));else localStorage.removeItem(STORAGE.session)}
async function complaintApi(path,options={}){
  const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(data?.error||`Request failed (${response.status}).`);
  return data;
}
function mergeComplaints(records){const merged=new Map(state.complaints.map(record=>[record.id,record]));records.forEach(record=>merged.set(record.id,{...merged.get(record.id),...record}));state.complaints=[...merged.values()]}
function escapeHTML(value=''){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function go(route){const known=['home','submit','track','dashboard','admin'];state.route=known.includes(route)?route:'home';document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${state.route}`));document.querySelectorAll('[data-route]').forEach(a=>a.classList.toggle('active',a.dataset.route===state.route));document.querySelector('.main-nav').classList.remove('open');if(state.route==='dashboard')renderDashboard();if(state.route==='admin')renderAdmin();if(state.route==='submit')loadSubmitMap();window.scrollTo({top:0,behavior:'smooth'});history.replaceState(null,'',`#${state.route}`)}
function toast(message,error=false){const el=document.querySelector('#toast');el.querySelector('span').textContent=message;el.classList.toggle('error',error);el.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('show'),3200)}
function showAuth(mode='login'){state.authMode=mode;updateAuthMode();document.querySelector('#auth-modal').classList.add('open');document.querySelector('#auth-modal').setAttribute('aria-hidden','false');document.body.style.overflow='hidden';setTimeout(()=>document.querySelector('#auth-form [name="email"]').focus(),80)}
function closeAuth(){document.querySelector('#auth-modal').classList.remove('open');document.querySelector('#auth-modal').setAttribute('aria-hidden','true');document.body.style.overflow=''}
function updateAuthMode(){const register=state.authMode==='register';document.querySelectorAll('[data-auth-mode]').forEach(b=>b.classList.toggle('active',b.dataset.authMode===state.authMode));document.querySelector('#name-field').classList.toggle('hidden',!register);document.querySelector('#phone-field').classList.toggle('hidden',!register);const form=document.querySelector('#auth-form');form.elements.name.required=register;form.elements.phone.required=false;form.elements.password.autocomplete=register?'new-password':'current-password';document.querySelector('#auth-title').textContent=register?'Create your account':'Welcome back';document.querySelector('#auth-subtitle').textContent=register?'Join your neighbors and follow your reports.':'Sign in to keep up with your reports.';document.querySelector('.auth-submit span').textContent=register?'Create account':'Sign in';document.querySelector('#auth-message').textContent=''}
function updateAccount(){const user=state.users.find(u=>u.id===state.session?.userId);document.querySelector('#account-label').textContent=user?user.fullName.split(' ')[0]:'Sign in';document.querySelector('#profile-name').textContent=user?.fullName||'Guest resident';document.querySelector('#profile-email').textContent=user?.email||'Reports saved in this browser';document.querySelector('#profile-avatar').textContent=user?user.fullName.split(' ').map(s=>s[0]).join('').slice(0,2).toUpperCase():'CF'}
function formatDate(date){return new Intl.DateTimeFormat('en',{month:'short',day:'numeric',year:'numeric'}).format(new Date(date))}
async function hashPasscode(passcode){const bytes=new TextEncoder().encode(passcode);const digest=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('')}
function statusClass(status){return `status-${status.toLowerCase().replaceAll(' ','-')}`}
function renderDashboard(){updateAccount();const user=state.users.find(u=>u.id===state.session?.userId);const ownerId=user?.id||'guest';const records=state.complaints.filter(c=>c.userId===ownerId);document.querySelector('#user-total').textContent=records.length;document.querySelector('#user-resolved').textContent=records.filter(c=>c.status==='Resolved').length;document.querySelector('#user-progress').textContent=records.filter(c=>c.status!=='Resolved').length;document.querySelector('#report-count').textContent=`${records.length} report${records.length===1?'':'s'}`;const list=document.querySelector('#user-reports');list.innerHTML=records.length?records.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(c=>`<div class="report-row"><div><strong>${escapeHTML(c.title)}</strong><small>${escapeHTML(c.id)} · ${escapeHTML(c.category)} · ${formatDate(c.createdAt)}</small></div><div class="report-row-right"><span class="status-pill ${statusClass(c.status)}">${escapeHTML(c.status)}</span><a href="#track" data-track-id="${escapeHTML(c.id)}">View progress <i class="fa-solid fa-arrow-right"></i></a></div></div>`).join(''):`<div class="empty-state"><i class="fa-regular fa-clipboard"></i>No reports yet. Submit an issue and it will show up here.</div>`}
function updateMetrics(){const total=state.complaints.length,resolved=state.complaints.filter(c=>c.status==='Resolved').length;document.querySelector('#metric-total').textContent=total.toLocaleString();document.querySelector('#metric-resolved').textContent=resolved.toLocaleString();document.querySelector('#metric-pending').textContent=Math.max(0,total-resolved).toLocaleString()}
function findComplaint(id){return state.complaints.find(c=>c.id.toLowerCase()===id.trim().toLowerCase())}
async function trackComplaint(id){
  let record=findComplaint(id);
  if(sharedApiEnabled){
    try{
      const remote=await complaintApi(`/api/complaints?id=${encodeURIComponent(id.trim())}`);
      if(remote){mergeComplaints([remote]);persist();record=remote}
    }catch(error){if(!record)toast(`Could not load report: ${error.message}`,true)}
  }
  renderTracking(record);
}
// --- Dispatch map state (tracking view) ---
let dispatchMap=null,dispatchVehicleMarker=null,dispatchDestMarker=null,dispatchRafId=null;

function renderTracking(record){
  const target=document.querySelector('#tracking-result');
  if(!record){target.innerHTML='<div class="tracking-card not-found"><i class="fa-solid fa-circle-exclamation"></i>No report found with that tracking ID. Check the number and try again.</div>';return}
  const steps=['Submitted','Under Review','In Progress','Resolved'];
  const current=steps.indexOf(record.status);
  const showDispatch=record.status==='In Progress'&&Number.isFinite(Number(record.latitude))&&Number.isFinite(Number(record.longitude));
  target.innerHTML=`<article class="tracking-card">
    <div class="tracking-head">
      <div><div class="tracking-id">${escapeHTML(record.title)}</div>
      <div class="tracking-meta"><span><i class="fa-solid fa-hashtag"></i> ${escapeHTML(record.id)}</span><span><i class="fa-regular fa-calendar"></i> ${formatDate(record.createdAt)}</span></div></div>
      <span class="status-pill ${statusClass(record.status)}">${escapeHTML(record.status)}</span>
    </div>
    <div class="stepper" style="--step-progress:${current<0?0:(current/(steps.length-1))*75}%">${steps.map((s,i)=>`<div class="step ${i<=current?'done':''} ${i===current?'current':''}"><span class="step-dot">${i<current?'<i class="fa-solid fa-check"></i>':i+1}</span>${s}</div>`).join('')}</div>
    <div class="tracking-meta"><span><i class="fa-solid fa-layer-group"></i> ${escapeHTML(record.category)}</span><span><i class="fa-solid fa-location-dot"></i> ${escapeHTML(record.zone||record.location)}</span><span><i class="fa-solid fa-building"></i> ${escapeHTML(record.department||'Awaiting assignment')}</span></div>
    ${showDispatch?`<div class="dispatch-panel"><div class="dispatch-header"><span class="dispatch-live-pill"><span class="dispatch-pulse-dot"></span>UNIT EN ROUTE</span><span class="dispatch-eta"><i class="fa-solid fa-truck-fast"></i> Service team dispatched</span></div><div id="tracking-dispatch-map" class="tracking-dispatch-map" aria-label="Live dispatch map"></div></div>`:''}
  </article>`;
  if(dispatchRafId){cancelAnimationFrame(dispatchRafId);dispatchRafId=null}
  if(dispatchMap){dispatchMap.remove();dispatchMap=null}
  dispatchVehicleMarker=null;dispatchDestMarker=null;
  if(showDispatch)initTrackingDispatchMap(record);
}

function initTrackingDispatchMap(record){
  const mapEl=document.querySelector('#tracking-dispatch-map');
  if(!mapEl)return;
  const destLat=Number(record.latitude),destLng=Number(record.longitude);

  dispatchMap=L.map(mapEl,{zoomControl:true,scrollWheelZoom:true}).setView([destLat,destLng],15);
  const street=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',maxZoom:19});
  street.addTo(dispatchMap);

  // Destination marker — red pin
  const destIcon=L.divIcon({className:'',html:'<span class="dispatch-dest-marker"><i class="fa-solid fa-location-dot"></i></span>',iconSize:[28,28],iconAnchor:[14,28]});
  dispatchDestMarker=L.marker([destLat,destLng],{icon:destIcon,title:'Complaint location'}).addTo(dispatchMap);
  dispatchDestMarker.bindPopup(`<strong>${escapeHTML(record.title)}</strong><br><small>${escapeHTML(record.location)}</small>`).openPopup();

  // Vehicle marker — emoji + ring
  const vehicleIcon=L.divIcon({className:'',html:'<div class="dispatch-vehicle-marker"><span class="dispatch-vehicle-icon">🛠️</span><span class="dispatch-vehicle-ring"></span></div>',iconSize:[44,44],iconAnchor:[22,22]});

  const startAnimation=(startLat,startLng)=>{
    if(dispatchVehicleMarker)dispatchMap.removeLayer(dispatchVehicleMarker);
    dispatchVehicleMarker=L.marker([startLat,startLng],{icon:vehicleIcon,title:'Service vehicle',zIndexOffset:1000}).addTo(dispatchMap);

    const bounds=L.latLngBounds([[startLat,startLng],[destLat,destLng]]);
    dispatchMap.fitBounds(bounds,{padding:[40,40]});

    const DURATION=5000;
    const startTime=performance.now();
    const lerp=(a,b,t)=>a+(b-a)*t;
    const ease=t=>t<0.5?2*t*t:1-Math.pow(-2*t+2,2)/2;

    const animate=(now)=>{
      const t=ease(Math.min((now-startTime)/DURATION,1));
      const curLat=lerp(startLat,destLat,t);
      const curLng=lerp(startLng,destLng,t);
      dispatchVehicleMarker.setLatLng([curLat,curLng]);
      if(t<1){dispatchRafId=requestAnimationFrame(animate)}else{dispatchRafId=null}
    };
    dispatchRafId=requestAnimationFrame(animate);
  };

  if(navigator.geolocation){
    navigator.geolocation.getCurrentPosition(
      pos=>startAnimation(pos.coords.latitude+0.002,pos.coords.longitude+0.002),
      ()=>startAnimation(destLat+0.018,destLng-0.012),
      {enableHighAccuracy:false,timeout:6000}
    );
  }else{
    startAnimation(destLat+0.018,destLng-0.012);
  }
}
function generateId(){let id;do{const digits=new Uint8Array(12);crypto.getRandomValues(digits);id=`CF-${[...digits].map(digit=>digit%10).join('')}`}while(findComplaint(id));return id}
function buildComplaintPayload(data){return{title:String(data.get('title')||'').trim(),description:String(data.get('description')||'').trim(),category:String(data.get('category')||''),latitude:selectedLocation.latitude,longitude:selectedLocation.longitude,address:selectedLocation.address||String(data.get('location')||'').trim()}}
window.civicFlowBuildComplaintPayload=buildComplaintPayload;
async function compressComplaintImage(file){
  if(!file||!file.size)return null;
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('Choose a JPEG, PNG, or WebP image.');
  const bitmap=await createImageBitmap(file),scale=Math.min(1,1800/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  let quality=.84,blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
  while(blob&&blob.size>1_500_000&&quality>.5){quality-=.08;blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));}
  if(!blob||blob.size>1_500_000)throw new Error('This photo is too large to upload. Choose a smaller image.');
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not read the selected photo.'));reader.readAsDataURL(blob)});
}
async function submitComplaint(form){
  if(!form.reportValidity())return;
  const data=new FormData(form),payload=buildComplaintPayload(data);
  if(!payload.address&&payload.latitude===null){document.querySelector('#geo-status').textContent='Choose a map location or enter an address before sending.';return}
  const submitButton=form.querySelector('[type="submit"]');
  try{payload.image=await compressComplaintImage(data.get('image'));if(payload.image&&!sharedApiEnabled)throw new Error('Photo uploads need the deployed shared database to be configured.');}catch(error){toast(error.message,true);return}
  let record={id:generateId(),userId:state.session?.userId||'guest',...payload,location:payload.address,zone:zoneFromLocation(payload.address),status:'Submitted',department:departmentFor(payload.category),createdAt:new Date().toISOString()};
  if(sharedApiEnabled){
    submitButton.disabled=true;
    try{record=await complaintApi('/api/complaints',{method:'POST',body:JSON.stringify(record)})}
    catch(error){toast(`Report could not be saved: ${error.message}`,true);submitButton.disabled=false;return}
    finally{submitButton.disabled=false}
  }
  delete record.image;state.complaints.unshift(record);persist();updateMetrics();form.reset();resetImagePreview();selectedLocation.latitude=null;selectedLocation.longitude=null;selectedLocation.address='';clearSubmitMarker();document.querySelector('#geo-status').textContent='Click the map or drag the marker to choose a location';toast(`Report sent — your ID is ${record.id}`);go('track');document.querySelector('#track-input').value=record.id;renderTracking(record)
}
function resetImagePreview(){const wrap=document.querySelector('#image-preview-wrap'),img=document.querySelector('#image-preview');if(img?.dataset.objectUrl)URL.revokeObjectURL(img.dataset.objectUrl);if(img){img.removeAttribute('src');delete img.dataset.objectUrl}if(wrap)wrap.hidden=true}
function zoneFromLocation(text){const s=text.toLowerCase();for(const z of ['northside','central','east district','riverside','west end'])if(s.includes(z))return z.replace(/\b\w/g,c=>c.toUpperCase());return 'Citywide'}
function departmentFor(category){return ({Roads:'Public Works',Sanitation:'Environmental Services',Streetlights:'Street Services',Water:'Water Utilities','Public spaces':'Parks & Recreation'})[category]||'City Services'}
function setMapPin(lat,lng){
  if(!submitMap)return;
  if(submitMapProvider==='google'){
    const position={lat:Number(lat),lng:Number(lng)};
    if(submitMarker)submitMarker.setPosition(position);
    else{
      submitMarker=new google.maps.Marker({position,map:submitMap,draggable:true,title:'Complaint location'});
      submitMarker.addListener('dragend',()=>{const p=submitMarker.getPosition();updateSelectedLocation(p.lat(),p.lng());googleReverse(p.lat(),p.lng())});
    }
    submitMap.setCenter(position);submitMap.setZoom(Math.max(submitMap.getZoom()||5,15));return;
  }
  if(submitMarker){submitMarker.setLatLng([lat,lng])}
  else{submitMarker=L.marker([lat,lng],{draggable:true,title:'Complaint location'}).addTo(submitMap);submitMarker.on('dragend',e=>{const p=e.target.getLatLng();updateSelectedLocation(p.lat,p.lng);nominatimReverse(p.lat,p.lng)})}
  submitMap.setView([lat,lng],Math.max(submitMap.getZoom(),15));
}
function clearSubmitMarker(){
  if(!submitMarker)return;
  if(submitMapProvider==='google')submitMarker.setMap(null);
  else submitMap?.removeLayer(submitMarker);
  submitMarker=null;
}
function updateSelectedLocation(lat,lng,address=''){
  selectedLocation.latitude=Number(Number(lat).toFixed(6));
  selectedLocation.longitude=Number(Number(lng).toFixed(6));
  selectedLocation.address=address;
  document.querySelector('[name="latitude"]').value=selectedLocation.latitude;
  document.querySelector('[name="longitude"]').value=selectedLocation.longitude;
  document.querySelector('[name="address"]').value=selectedLocation.address;
  document.querySelector('[name="location"]').value=selectedLocation.address;
  document.querySelector('#geo-status').textContent=`Selected: ${selectedLocation.latitude.toFixed(5)}, ${selectedLocation.longitude.toFixed(5)}`;
}
async function nominatimReverse(lat,lng){
  try{
    const r=await fetchNominatim(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`);
    const d=await r.json();
    if(d.display_name){updateSelectedLocation(lat,lng,d.display_name);document.querySelector('[name="location"]').value=d.display_name}
  }catch(e){console.info('Reverse geocode unavailable',e)}
}
function googleReverse(lat,lng){
  if(!googleGeocoder)return;
  googleGeocoder.geocode({location:{lat:Number(lat),lng:Number(lng)}},(results,status)=>{
    if(status==='OK'&&results?.[0])updateSelectedLocation(lat,lng,results[0].formatted_address);
  });
}
async function nominatimSearch(query){
  const r=await fetchNominatim(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`);
  const d=await r.json();
  return d[0]||null;
}
function loadSubmitMap(){
  if(submitMap){if(submitMapProvider==='google')google.maps.event.trigger(submitMap,'resize');else submitMap.invalidateSize();return}
  const el=document.querySelector('#leaflet-map');
  if(!el)return;
  const key=String(window.CIVICFLOW_MAPS_API_KEY||'').trim();
  if(window.CIVICFLOW_MAP_PROVIDER==='google'&&key){
    document.querySelector('#geo-status').textContent='Loading Google Maps…';
    loadGoogleMapsApi(key).then(()=>{
      if(!el.isConnected||submitMap)return;
      submitMapProvider='google';
      submitMap=new google.maps.Map(el,{center:{lat:20.5937,lng:78.9629},zoom:5,mapTypeControl:true,streetViewControl:true,fullscreenControl:true});
      googleGeocoder=new google.maps.Geocoder();
      submitMap.addListener('click',event=>{
        const lat=event.latLng.lat(),lng=event.latLng.lng();
        updateSelectedLocation(lat,lng);setMapPin(lat,lng);googleReverse(lat,lng);
      });
      document.querySelector('#geo-status').textContent='Click the map or drag the marker to choose a location';
    }).catch(error=>{
      console.warn('Google Maps failed to load; using OpenStreetMap.',error);
      initLeafletSubmitMap(el);
      document.querySelector('#geo-status').textContent='Google Maps did not load; the OpenStreetMap fallback is active.';
    });
    return;
  }
  submitMapProvider='osm';
  initLeafletSubmitMap(el);
}
function loadGoogleMapsApi(apiKey){
  if(window.google?.maps)return Promise.resolve();
  if(googleMapsLoadPromise)return googleMapsLoadPromise;
  googleMapsLoadPromise=new Promise((resolve,reject)=>{
    const callbackName='civicFlowGoogleMapsReady';
    const timeout=setTimeout(()=>reject(new Error('Google Maps load timed out')),15000);
    window[callbackName]=()=>{clearTimeout(timeout);delete window[callbackName];resolve()};
    const script=document.createElement('script');
    script.src=`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&callback=${callbackName}&loading=async`;
    script.async=true;
    script.onerror=()=>{clearTimeout(timeout);delete window[callbackName];reject(new Error('Google Maps script failed'))};
    document.head.appendChild(script);
  });
  return googleMapsLoadPromise;
}
function initLeafletSubmitMap(el){
  if(submitMap||!window.L)return;
  submitMap=L.map(el,{zoomControl:true}).setView([20.5937,78.9629],5);
  const street=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',maxZoom:19});
  street.addTo(submitMap);
  submitMap.on('click',e=>{
    updateSelectedLocation(e.latlng.lat,e.latlng.lng);
    setMapPin(e.latlng.lat,e.latlng.lng);
    nominatimReverse(e.latlng.lat,e.latlng.lng);
  });
  document.querySelector('#geo-status').textContent='Click the map or drag the marker to choose a location';
}
function setGeoPosition(position){
  const {latitude,longitude}=position.coords;
  updateSelectedLocation(latitude,longitude);
  if(submitMap){setMapPin(latitude,longitude);if(submitMapProvider==='google')googleReverse(latitude,longitude);else nominatimReverse(latitude,longitude)}
}
function renderAdmin(){const allowed=sessionStorage.getItem('civicflow.admin')==='true';document.querySelector('#admin-login').classList.toggle('hidden',allowed);document.querySelector('#admin-console').classList.toggle('hidden',!allowed);if(allowed){drawCharts();renderQueue();renderAdminMap();if(sharedApiEnabled)refreshSharedComplaints()}}
async function refreshSharedComplaints(){
  const token=sessionStorage.getItem('civicflow.adminToken');
  if(!token)return;
  try{
    const records=await complaintApi('/api/complaints',{headers:{'x-admin-token':token}});
    mergeComplaints(records);
    persist();updateMetrics();drawCharts();renderQueue();renderAdminMap();
  }catch(error){toast(`Could not load shared reports: ${error.message}`,true)}
}
function drawCharts(){if(!window.Chart)return;const cats=['Roads','Sanitation','Streetlights','Water','Public spaces','Other'];const statuses=['Submitted','Under Review','In Progress','Resolved'];Object.values(state.charts).forEach(chart=>chart.destroy());state.charts.category=new Chart(document.querySelector('#category-chart'),{type:'bar',data:{labels:cats,datasets:[{data:cats.map(cat=>state.complaints.filter(c=>c.category===cat).length),backgroundColor:['#06b6d4','#32b891','#f0b547','#818cf8','#f07868','#a7b4bd'],borderRadius:5,maxBarThickness:32}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{font:{size:9},color:'#82909d'}},y:{beginAtZero:true,grid:{color:'#eff3f5'},ticks:{stepSize:1,font:{size:9},color:'#98a3ac'}}}}});state.charts.status=new Chart(document.querySelector('#status-chart'),{type:'doughnut',data:{labels:statuses,datasets:[{data:statuses.map(s=>state.complaints.filter(c=>c.status===s).length),backgroundColor:['#61a8cb','#f0b547','#08a4bc','#26b47f'],borderWidth:0,hoverOffset:5}]},options:{responsive:true,maintainAspectRatio:false,cutout:'69%',plugins:{legend:{position:'right',labels:{boxWidth:8,boxHeight:8,padding:13,font:{size:9},color:'#738292'}}}}})}
function renderQueue(){const q=document.querySelector('#admin-search').value.toLowerCase(),cat=document.querySelector('#admin-category').value;const rows=state.complaints.filter(c=>(!cat||c.category===cat)&&(!q||[c.id,c.title,c.location,c.description].join(' ').toLowerCase().includes(q)));document.querySelector('#admin-total').textContent=state.complaints.length;document.querySelector('#admin-resolved').textContent=state.complaints.filter(c=>c.status==='Resolved').length;document.querySelector('#admin-pending').textContent=state.complaints.filter(c=>['Submitted','Under Review'].includes(c.status)).length;document.querySelector('#admin-progress').textContent=state.complaints.filter(c=>c.status==='In Progress').length;document.querySelector('#admin-rows').innerHTML=rows.length?rows.map(c=>`<tr><td><strong>${escapeHTML(c.title)}</strong><small>${escapeHTML(c.id)} · ${formatDate(c.createdAt)}</small></td><td>${escapeHTML(c.category)}</td><td>${escapeHTML(c.location)}</td><td>${c.photoUrl?`<a href="${escapeHTML(c.photoUrl)}" target="_blank" rel="noopener noreferrer">View photo</a>`:`<span class="muted-photo">—</span>`}</td><td><select data-update="status" data-id="${escapeHTML(c.id)}" aria-label="Update status for ${escapeHTML(c.id)}">${['Submitted','Under Review','In Progress','Resolved'].map(s=>`<option ${c.status===s?'selected':''}>${s}</option>`).join('')}</select></td><td><select data-update="department" data-id="${escapeHTML(c.id)}" aria-label="Assign department for ${escapeHTML(c.id)}">${[...new Set([...departments,c.department||'City Services'])].map(d=>`<option ${c.department===d?'selected':''}>${escapeHTML(d)}</option>`).join('')}</select></td><td><button class="inspect-btn" data-inspect="${escapeHTML(c.id)}" aria-label="Inspect report"><i class="fa-regular fa-eye"></i></button></td></tr>`).join(''):'<tr><td colspan="7" class="no-rows">No reports match this search.</td></tr>'}
const statusColors={'Submitted':'#4389b6','Under Review':'#e5a82d','In Progress':'#08a4bc','Resolved':'#20a575'};
function renderAdminMap(records=state.complaints){
  const mapStatus=document.querySelector('#admin-map-status');
  const el=document.querySelector('#admin-map');
  if(!el)return;
  if(!adminLMap){
    adminLMap=L.map(el).setView([20.5937,78.9629],5);
    const street=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',maxZoom:19});
    street.addTo(adminLMap);
  }
  adminLMarkers.forEach(m=>adminLMap.removeLayer(m));adminLMarkers=[];
  const bounds=[];
  records.forEach(record=>{
    const lat=Number(record.latitude??record.lat),lng=Number(record.longitude??record.lng);
    if(!Number.isFinite(lat)||!Number.isFinite(lng))return;
    const color=statusColors[record.status]||'#64748b';
    const icon=L.divIcon({className:'',html:`<span style="display:block;width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px #0004"></span>`,iconSize:[14,14],iconAnchor:[7,7]});
    const m=L.marker([lat,lng],{icon,title:`${record.id} · ${record.category}`})
      .bindPopup(`<div class="admin-map-info"><strong>${escapeHTML(record.id)}</strong><span>${escapeHTML(record.category)} · ${escapeHTML(record.status)}</span><p>${escapeHTML(record.description||'No description.')}</p></div>`)
      .addTo(adminLMap);
    adminLMarkers.push(m);bounds.push([lat,lng]);
  });
  if(bounds.length)adminLMap.fitBounds(bounds,{padding:[30,30]});
  mapStatus.textContent=`${bounds.length} MAPPED REPORT${bounds.length===1?'':'S'}`;
}
window.civicFlowRenderAdminMap=renderAdminMap;
document.addEventListener('click',event=>{const route=event.target.closest('[data-route]');if(route){event.preventDefault();go(route.dataset.route);return}if(event.target.closest('[data-action="register"]')){showAuth('register');return}if(event.target.closest('[data-action="auth"]')){if(state.session){go('dashboard')}else showAuth();return}if(event.target.closest('[data-action="close-modal"]')){closeAuth();return}const tab=event.target.closest('[data-auth-mode]');if(tab){state.authMode=tab.dataset.authMode;updateAuthMode();return}const category=event.target.closest('[data-category]');if(category){go('submit');document.querySelector('[name="category"]').value=category.dataset.category;return}const toggle=event.target.closest('.toggle-password');if(toggle){const input=toggle.parentElement.querySelector('input');input.type=input.type==='password'?'text':'password';toggle.setAttribute('aria-label',input.type==='password'?'Show password':'Hide password');toggle.innerHTML=`<i class="fa-regular fa-eye${input.type==='password'?'':'-slash'}"></i>`;return}const trackLink=event.target.closest('[data-track-id]');if(trackLink){event.preventDefault();go('track');document.querySelector('#track-input').value=trackLink.dataset.trackId;trackComplaint(trackLink.dataset.trackId);return}const inspect=event.target.closest('[data-inspect]');if(inspect){const record=findComplaint(inspect.dataset.inspect);if(record)alert(`CIVICFLOW REPORT · ${record.id}\n\nTitle: ${record.title}\nCategory: ${record.category}\nLocation: ${record.location}\nZone: ${record.zone}\nStatus: ${record.status}\nDepartment: ${record.department}\nReported: ${new Date(record.createdAt).toLocaleString()}\n\nDescription:\n${record.description}\n\nCoordinates: ${record.latitude??'Not supplied'}, ${record.longitude??'Not supplied'}`);return}if(event.target.closest('.mobile-menu'))document.querySelector('.main-nav').classList.toggle('open')});
document.querySelector('#auth-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;if(!form.reportValidity())return;const d=new FormData(form),email=d.get('email').trim().toLowerCase(),message=document.querySelector('#auth-message');if(state.authMode==='register'){if(d.get('phone')&&!/^[0-9]{10}$/.test(d.get('phone'))){message.textContent='Phone number must have 10 digits, or leave it blank.';return}if(state.users.some(u=>u.email===email)){message.textContent='An account with this email already exists. Sign in instead.';return}const user={id:`usr-${crypto.randomUUID()}`,fullName:d.get('name').trim(),email,phone:d.get('phone'),passcodeHash:await hashPasscode(d.get('password')),createdAt:new Date().toISOString()};state.users.push(user);state.session={userId:user.id};persist();closeAuth();updateAccount();toast('Your CivicFlow account is ready.');if(state.route==='dashboard')renderDashboard()}else{const passcodeHash=await hashPasscode(d.get('password'));const user=state.users.find(u=>u.email===email&&u.passcodeHash===passcodeHash);if(!user){message.textContent='Email or password is incorrect. If you have not registered in this browser, create an account first.';return}state.session={userId:user.id};persist();closeAuth();updateAccount();toast(`Welcome back, ${user.fullName.split(' ')[0]}.`);if(state.route==='dashboard')renderDashboard()}});
document.querySelector('#complaint-form').addEventListener('submit',event=>{event.preventDefault();submitComplaint(event.currentTarget)});
document.querySelector('#complaint-image')?.addEventListener('change',event=>{const file=event.target.files?.[0],wrap=document.querySelector('#image-preview-wrap'),img=document.querySelector('#image-preview');resetImagePreview();if(!file)return;if(file.size>15*1024*1024){event.target.value='';toast('Choose a photo smaller than 15 MB.',true);return}const url=URL.createObjectURL(file);img.src=url;img.dataset.objectUrl=url;wrap.hidden=false});
document.querySelector('#remove-image')?.addEventListener('click',()=>{const input=document.querySelector('#complaint-image');if(input)input.value='';resetImagePreview()});
document.querySelector('[name="location"]').addEventListener('input',event=>{selectedLocation.address=event.target.value.trim();selectedLocation.latitude=null;selectedLocation.longitude=null;document.querySelector('[name="latitude"]').value='';document.querySelector('[name="longitude"]').value='';document.querySelector('[name="address"]').value=selectedLocation.address;clearSubmitMarker()});
document.querySelector('#track-form').addEventListener('submit',event=>{event.preventDefault();const id=document.querySelector('#track-input').value;if(!id.trim()){document.querySelector('#track-input').focus();return}trackComplaint(id)});
document.querySelector('#geo-button').addEventListener('click',()=>{const status=document.querySelector('#geo-status');if(!navigator.geolocation){status.textContent='Geolocation is not supported by this browser.';return}status.textContent='Finding your location…';navigator.geolocation.getCurrentPosition(setGeoPosition,err=>{status.textContent=err.code===1?'Location access was denied. You can enter an address instead.':'Could not get your location. Please try again or enter an address.'},{enableHighAccuracy:true,timeout:12000})});
async function doPlaceSearch(){const inp=document.querySelector('#place-search-input');if(!inp)return;const q=inp.value.trim();if(!q)return;inp.disabled=true;try{if(submitMapProvider==='google'&&googleGeocoder){const result=await new Promise((resolve,reject)=>googleGeocoder.geocode({address:q},(items,status)=>status==='OK'&&items?.[0]?resolve({lat:items[0].geometry.location.lat(),lng:items[0].geometry.location.lng(),address:items[0].formatted_address}):status==='ZERO_RESULTS'?resolve(null):reject(new Error(status))));if(result){updateSelectedLocation(result.lat,result.lng,result.address);setMapPin(result.lat,result.lng)}else document.querySelector('#geo-status').textContent='Address not found. Try a different search.'}else{const result=await nominatimSearch(q);if(result){const lat=Number(result.lat),lng=Number(result.lon);updateSelectedLocation(lat,lng,result.display_name);setMapPin(lat,lng)}else document.querySelector('#geo-status').textContent='Address not found. Try a different search.'}}catch(e){document.querySelector('#geo-status').textContent='Search unavailable. Click the map instead.'}finally{inp.disabled=false}}
document.querySelector('#place-search-btn')?.addEventListener('click',doPlaceSearch);
document.querySelector('#place-search-input')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();doPlaceSearch()}});
document.querySelector('#admin-login-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const key=event.currentTarget.elements.key.value;
  if(sharedApiEnabled){
    try{
      const auth=await complaintApi('/api/admin-login',{method:'POST',body:JSON.stringify({key})});
      sessionStorage.setItem('civicflow.adminToken',auth.token);
    }catch(error){toast(error.message,true);return}
  }else if(!key.trim()){
    toast('Enter an access key.',true);return;
  }
  sessionStorage.setItem('civicflow.admin','true');
  renderAdmin();
  toast('Operations access granted.');
});
document.querySelector('#admin-search').addEventListener('input',renderQueue);document.querySelector('#admin-category').addEventListener('change',renderQueue);
document.querySelector('#admin-rows').addEventListener('change',async event=>{
  const select=event.target.closest('[data-update]');if(!select)return;
  const record=findComplaint(select.dataset.id);if(!record)return;
  const field=select.dataset.update,previous=record[field],value=select.value;
  record[field]=value;persist();
  if(sharedApiEnabled){
    try{await complaintApi(`/api/complaints?id=${encodeURIComponent(record.id)}`,{method:'PATCH',headers:{'x-admin-token':sessionStorage.getItem('civicflow.adminToken')||''},body:JSON.stringify({[field]:value})})}
    catch(error){record[field]=previous;persist();renderQueue();toast(`Update failed: ${error.message}`,true);return}
  }
  renderQueue();drawCharts();renderAdminMap();updateMetrics();toast(`${field==='status'?'Status':'Department'} updated for ${record.id}.`)
});
document.querySelectorAll('a[href^="#"]').forEach(a=>{if(!a.dataset.route)a.addEventListener('click',event=>event.preventDefault())});
window.addEventListener('storage',event=>{
  if(event.storageArea!==localStorage||event.key!==STORAGE.complaints)return;
  state.complaints=loadJSON(STORAGE.complaints,seedComplaints).filter(record=>!legacyDemoIds.has(record.id));
  updateMetrics();
  if(state.route==='dashboard')renderDashboard();
  if(state.route==='admin'&&sessionStorage.getItem('civicflow.admin')==='true'){
    drawCharts();
    renderQueue();
    renderAdminMap();
  }
});
window.addEventListener('hashchange',()=>go(location.hash.slice(1)));updateAccount();updateMetrics();go(location.hash.slice(1)||(location.pathname==='/admin'||location.pathname==='/admin/'?'admin':'home'));
