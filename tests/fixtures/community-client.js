// Synthetic browser contract fixture. Only injected into an isolated test context.
// Never referenced by index.html or sent to a live Supabase project.
(() => {
    const userA={id:'00000000-0000-0000-0000-000000000001',email:'private-a@example.invalid',user_metadata:{full_name:'River watcher'}};
    const userB={id:'00000000-0000-0000-0000-000000000002',email:'private-b@example.invalid',user_metadata:{full_name:'Coast watcher'}};
    const profiles=[{id:userA.id,username:'river_watcher',display_name:'River watcher',bio:'Watching local waterways',city:'Cebu City',barangay:'Lahug',avatar_url:null,created_at:'2025-01-02T12:00:00Z'}, {id:userB.id,username:'coast_watcher',display_name:'Coast watcher',bio:'',city:'Lapu-Lapu City',barangay:null,avatar_url:null,created_at:'2025-02-01T12:00:00Z'}];
    const reports=Array.from({length:25},(_,i)=>({id:`10000000-0000-0000-0000-${String(i+1).padStart(12,'0')}`,reporter_id:i===24?null:i%2?userB.id:userA.id,location:`Test observation ${i+1}`,pollution_type:i%2?'Water Pollution':'Air Pollution',severity:i%3?'low':'high',description:'Synthetic observation for isolated browser testing.',latitude:10.3,longitude:123.9,photo_url:null,video_url:null,created_at:new Date(Date.UTC(2026,9,20-i)).toISOString(),verification_status:i%2?'Verified':'Pending verification',city:i===24?null:i%2?'Lapu-Lapu City':'Cebu City',barangay:i%2?null:'Lahug'}));
    const feedback=[{id:'20000000-0000-0000-0000-000000000001',report_id:reports[0].id,user_id:userB.id,message:'A test-only observation.',created_at:'2026-10-20T15:00:00Z'}];
    const votes=[];
    const state=window.communityFixture={user:null,userA,userB,profiles,reports,feedback,votes,calls:[],uploads:[],removals:[],failSave:false,failDirectory:false,providerError:true,callbacks:[]};
    const notify=event=>state.callbacks.forEach(cb=>cb(event,{user:state.user}));
    const directory=()=>reports.map(r=>({...r,reporter_severity:r.severity,vote_counts:Object.fromEntries(['low','moderate','high','severe'].map(level=>[level,votes.filter(v=>v.report_id===r.id&&v.severity===level).length])),activity_count:feedback.filter(f=>f.report_id===r.id).length+votes.filter(v=>v.report_id===r.id).length,severity_rank:{low:1,moderate:2,high:3,severe:4}[r.severity]}));
    class Query {
        constructor(table){this.table=table;this.filters=[];this.orders=[];this.start=0;this.end=Infinity;this.operation='read';}
        select(columns,options={}){this.columns=columns;this.options=options;this.returning=true;return this;}
        eq(key,value){this.filters.push(row=>String(row[key])===String(value));return this;}
        in(key,values){this.filters.push(row=>values.map(String).includes(String(row[key])));return this;}
        not(key,operator,value){this.filters.push(row=>row[key]!==value);return this;}
        or(text){state.calls.push({or:text});const term=text.split('.ilike.%')[1]?.split('%')[0].toLowerCase()||'';this.filters.push(row=>[row.location,row.description,row.city,row.barangay].some(v=>String(v||'').toLowerCase().includes(term)));return this;}
        order(key,options={}){this.orders.push([key,options.ascending!==false]);return this;}
        range(start,end){this.start=start;this.end=end;return this;}
        limit(limit){this.end=limit-1;return this;}
        single(){this.singleRow=true;return this;}
        maybeSingle(){this.singleRow=true;return this;}
        insert(payload){this.operation='insert';this.payload=payload;return this;}
        update(payload){this.operation='update';this.payload=payload;return this;}
        delete(){this.operation='delete';return this;}
        then(resolve,reject){return Promise.resolve().then(()=>this.run()).then(resolve,reject);}
        run(){
            state.calls.push({table:this.table,columns:this.columns,operation:this.operation,start:this.start,end:Number.isFinite(this.end)?this.end:null,payload:this.payload});
            if(this.table==='cleanmap_report_directory'&&state.failDirectory)return{error:{message:'Fixture failure'}};
            const source=this.table==='profiles'?profiles.map(p=>({id:p.id,role:'member'})):this.table==='cleanmap_public_profiles'?profiles:this.table==='cleanmap_report_directory'?directory():this.table==='reports'?reports:this.table==='feedback'?feedback:votes;
            let rows=source.filter(row=>this.filters.every(filter=>filter(row)));
            if(this.operation==='insert'){const row={id:crypto.randomUUID(),created_at:new Date().toISOString(),...this.payload};source.push(row);rows=[row];}
            if(this.operation==='update') rows.forEach(row=>Object.assign(row,this.payload));
            if(this.operation==='delete')rows.forEach(row=>source.splice(source.indexOf(row),1));
            for(const [key,asc] of [...this.orders].reverse()) rows.sort((a,b)=>(a[key]>b[key]?1:a[key]<b[key]?-1:0)*(asc?1:-1));
            const count=rows.length;rows=rows.slice(this.start,this.end+1);
            return{data:this.options?.head?null:structuredClone(this.singleRow?rows[0]||null:rows),error:null,count};
        }
    }
    window.supabase={createClient:(url,key,options)=>{
        state.clientOptions=options;
        return {
            from:table=>new Query(table),
            rpc:async(name,args)=>{
                state.calls.push({rpc:name,args});
                if(name==='cleanmap_ensure_profile') {
                    if(!profiles.some(p=>p.id===state.user.id))profiles.push({id:state.user.id,display_name:state.user.user_metadata.full_name,avatar_url:state.user.user_metadata.avatar_url,created_at:new Date().toISOString()});
                }
                if(name==='cleanmap_save_profile') {
                    if(state.failSave)return{error:{code:'23505'}};
                    const p=profiles.find(p=>p.id===state.user.id);Object.assign(p,Object.fromEntries(Object.entries(args).map(([key,value])=>[key.slice(2),value])));
                }
                if(name==='cleanmap_report_areas')return{data:[{city:'Cebu City',barangay:'Lahug'},{city:'Lapu-Lapu City',barangay:null}],error:null};
                if(name==='cleanmap_report_statistics')return{data:{total:reports.length,low:reports.filter(r=>r.severity==='low').length,moderate:0,high:reports.filter(r=>r.severity==='high').length,severe:0,areas:reports.length},error:null};
                return{data:null,error:null};
            },
            storage:{from:bucket=>({
                upload:async(path,blob,options)=>{state.uploads.push({bucket,path,size:blob.size,type:options.contentType});return{error:null};},
                getPublicUrl:path=>({data:{publicUrl:`${url}/storage/v1/object/public/${bucket}/${path}`}}),
                remove:async(paths)=>{state.removals.push(...paths);return{error:null};},
                createSignedUrl:async path=>({data:{signedUrl:`https://example.invalid/${path}`},error:null})
            })},
            auth:{
                getSession:async()=>({data:{session:state.user?{user:state.user}:null},error:null}),
                onAuthStateChange:callback=>{state.callbacks.push(callback);return{data:{subscription:{unsubscribe(){}}}};},
                signInWithPassword:async args=>{state.calls.push({signin:args.email});state.user=userA;notify('SIGNED_IN');return{data:{session:{user:userA}},error:null};},
                signUp:async args=>{state.calls.push({signup:args});return{data:{session:null},error:null};},
                signOut:async()=>{state.user=null;notify('SIGNED_OUT');return{error:null};},
                resetPasswordForEmail:async(email,args)=>{state.calls.push({reset:email,...args});return{error:null};},
                updateUser:async args=>{state.calls.push({passwordUpdate:Boolean(args.password)});return{error:null};},
                signInWithOAuth:async args=>{state.calls.push({oauth:args});return state.providerError?{error:{message:'Provider disabled'}}:{data:{url:`${url}/auth/v1/authorize?provider=${args.provider}`},error:null};}
            }
        };
    }};
})();
