// Arquivo: js/SaasService.js

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore, collection, addDoc, getDocs, query, where, onSnapshot, doc, updateDoc, deleteDoc, setDoc, getDoc, writeBatch, limit, getCountFromServer, increment } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

// =========================================================================
// CONFIGURAÇÃO PADRÃO
// =========================================================================
const DEFAULT_SERVICE_FEE_PERCENTAGE = 0; 
const DEFAULT_RETENTION_DAYS = 30; 

const firebaseConfig = {
  apiKey: "AIzaSyCyzQpKqdgzV7czLpqr5IGLKBIRCrozWaY",
  authDomain: "hamburgueriasaas.firebaseapp.com",
  projectId: "hamburgueriasaas",
  storageBucket: "hamburgueriasaas.firebasestorage.app",
  messagingSenderId: "1074706224638",
  appId: "1:1074706224638:web:7faa3e6731ebf162ccdcaf",
  measurementId: "G-7QL9M9ERY8"
};

// App Principal (Sessão do Usuário Atual)
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

export class SaasService {
    constructor(restaurantId = null, forceAdmin = false) {
        this.db = db;
        this.auth = auth;
        this.restaurantId = null;
        this.userRole = null;
        
        // Verifica contexto (Super Admin, Setup ou Login)
        const isSuperAdmin = forceAdmin || window.location.pathname.includes('master') || window.location.pathname.includes('super_admin.html');
        const isSetupPage = window.location.pathname.includes('setup.html');
        const isLoginPage = window.location.pathname.includes('login.html');

        // Lógica de ID (Só roda se NÃO for Super Admin para evitar conflito de sessão)
        if (!isSuperAdmin && !isSetupPage) {
            if (restaurantId) {
                this.restaurantId = restaurantId;
            } else {
                const params = new URLSearchParams(window.location.search);
                const urlId = params.get('id');
                
                if (urlId) {
                    this.restaurantId = urlId;
                    // Salva no storage para persistência (F5)
                    localStorage.setItem('current_restaurant_id', urlId);
                } else {
                    // Recupera do storage ou usa fallback
                    this.restaurantId = localStorage.getItem('current_restaurant_id') || "empresa_01";
                }
            }
        }
        
        console.log("SaaS Iniciado. Contexto:", isSuperAdmin ? "SUPER ADMIN" : "CLIENTE", "| ID:", this.restaurantId);
        
        // O PORTEIRO (Bloqueio): Só inicia se for uma página de cliente ativa
        if (!isSuperAdmin && !isLoginPage && !isSetupPage && this.restaurantId) {
            this.checkStatus(); 
            if (window.location.pathname.includes('admin.html') || window.location.pathname.includes('index.html')) {
                this.checkAndRunMaintenance();
            }
        }
    }

    // =========================================================================
    // AUTENTICAÇÃO INTELIGENTE
    // =========================================================================

    // Verifica login ao carregar a página
    requireAuth(onSuccess, allowedRoles = []) {
        onAuthStateChanged(this.auth, async (user) => {
            if (user) {
                // Busca dados adicionais (Role e ID do Restaurante)
                const userData = await this.getUserData(user.uid);
                const role = userData ? userData.role : 'guest';
                this.userRole = role;
                
                // Proteção de Rotas: Super Admin vs Cliente
                const isMasterPage = window.location.pathname.includes('master');
                
                if (isMasterPage && role !== 'super_admin') {
                    alert("Acesso Negado: Área restrita a Super Admins.");
                    window.location.href = '../login.html';
                    return;
                }

                if (!isMasterPage && role === 'super_admin') {
                    console.warn("Super Admin visualizando área do cliente.");
                }
                
                // Se for Dono ou Funcionário, define o ID do restaurante na sessão
                if (role === 'owner' || role === 'employee') {
                    if (userData.restaurant_id) {
                        this.restaurantId = userData.restaurant_id;
                        localStorage.setItem('current_restaurant_id', this.restaurantId);
                        // Reinicia verificações de bloqueio com o ID correto
                        this.checkStatus();
                    }
                    this.checkStatus();
                }

                // VERIFICAÇÃO DE PERMISSÃO ESPECÍFICA (Para bloquear funcionário no admin)
                if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
                    if (role === 'employee') {
                        // Se funcionário tentar entrar no Admin, manda pro Garçom
                        window.location.href = 'garcom.html';
                        return;
                    }
                    alert("Acesso não autorizado para seu nível.");
                    this.logout();
                    return;
                }
                
                if (onSuccess) onSuccess(user, role);
            } else {
                // Redirecionamento de logout
                const isMaster = window.location.pathname.includes('master');
                window.location.href = isMaster ? '../login.html' : 'login.html';
            }
        });
    }

    async getUserData(uid) {
        const docSnap = await getDoc(doc(this.db, "users", uid));
        return docSnap.exists() ? docSnap.data() : null;
    }

    // LOGIN: Retorna User + Role para o front decidir o redirect
    async login(email, password) {
        try {
            const userCredential = await signInWithEmailAndPassword(this.auth, email, password);
            const userData = await this.getUserData(userCredential.user.uid);
            
            return {
                user: userCredential.user,
                role: userData ? userData.role : 'unknown', // 'super_admin', 'owner', 'employee'
                restaurantId: userData ? userData.restaurant_id : null
            };
        } catch (error) {
            throw new Error(this.translateAuthError(error.code));
        }
    }

    async logout() {
        await signOut(this.auth);
        localStorage.removeItem('current_restaurant_id');
        const isMaster = window.location.pathname.includes('master');
        window.location.href = isMaster ? '../login.html' : 'login.html';
    }

    // Cria usuário SEM deslogar o admin atual (App Secundário)
    // Usado para Donos e Funcionários
    async _createUserInternal(email, password, restaurantId, role, name = '') {
        const tempApp = initializeApp(firebaseConfig, "TempApp_" + Math.random());
        const tempAuth = getAuth(tempApp);

        try {
            const userCredential = await createUserWithEmailAndPassword(tempAuth, email, password);
            const user = userCredential.user;

            await setDoc(doc(this.db, "users", user.uid), {
                email: email,
                restaurant_id: restaurantId,
                role: role,
                name: name,
                created_at: new Date()
            });

            await signOut(tempAuth);
            await deleteApp(tempApp);
            return user;
        } catch (error) {
            await deleteApp(tempApp).catch(console.error);
            throw new Error(this.translateAuthError(error.code));
        }
    }

    async registerOwner(email, password, restaurantId) {
        return this._createUserInternal(email, password, restaurantId, 'owner');
    }

    async registerEmployee(email, password, restaurantId, name) {
        return this._createUserInternal(email, password, restaurantId, 'employee', name);
    }
    
    // Setup Inicial
    async registerSuperAdmin(email, password) {
        try {
            const userCredential = await createUserWithEmailAndPassword(this.auth, email, password);
            const user = userCredential.user;
            await setDoc(doc(this.db, "users", user.uid), {
                email: email, role: 'super_admin', created_at: new Date()
            });
            return user;
        } catch (error) {
            throw new Error(this.translateAuthError(error.code));
        }
    }

    // Troca de acesso (Substituição)
    async forceUpdateOwnerAccess(oldUid, newEmail, newPassword, restaurantId) {
        await this.registerOwner(newEmail, newPassword, restaurantId);
        if (oldUid) {
            await deleteDoc(doc(this.db, "users", oldUid));
        }
    }

    // Listar funcionários
    async getEmployees() {
        const q = query(collection(this.db, "users"), where("restaurant_id", "==", this.restaurantId), where("role", "==", "employee"));
        const snapshot = await getDocs(q);
        const employees = [];
        snapshot.forEach(doc => employees.push({ uid: doc.id, ...doc.data() }));
        return employees;
    }

    // Deletar funcionário (Remove acesso)
    async deleteEmployee(uid) {
        await deleteDoc(doc(this.db, "users", uid));
    }

    async unlinkOwner(uid) {
        await deleteDoc(doc(this.db, "users", uid));
    }
    
    async resetUserPassword(email) {
        try { await sendPasswordResetEmail(this.auth, email); }
        catch (error) { throw new Error(this.translateAuthError(error.code)); }
    }

    async getRestaurantOwner(restaurantId) {
        const q = query(collection(this.db, "users"), where("restaurant_id", "==", restaurantId), where("role", "==", "owner"));
        const snapshot = await getDocs(q);
        if (snapshot.empty) return null;
        const docData = snapshot.docs[0].data();
        return { uid: snapshot.docs[0].id, ...docData };
    }

    translateAuthError(code) {
        switch (code) {
            case 'auth/invalid-email': return 'E-mail inválido.';
            case 'auth/weak-password': return 'Senha fraca.';
            case 'auth/email-already-in-use': return 'E-mail já em uso.';
            case 'auth/user-not-found': return 'Usuário não encontrado.';
            case 'auth/wrong-password': return 'Senha incorreta.';
            default: return 'Erro: ' + code;
        }
    }

    // =========================================================================
    // SISTEMA DE BLOQUEIO (PORTEIRO)
    // =========================================================================
    checkStatus() {
        if (window.location.pathname.includes('master')) return;
        if (!this.restaurantId) return;
        
        const docRef = doc(this.db, "restaurants", this.restaurantId);
        
        // Cancela listener anterior se houver para não duplicar
        if (this.statusListenerUnsubscribe) this.statusListenerUnsubscribe();

        this.statusListenerUnsubscribe = onSnapshot(docRef, (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data();
                
                // 1. BLOQUEIO FINANCEIRO (Prioridade Máxima)
                // Se o Super Admin bloqueou por falta de pagamento, ninguém entra.
                if (data.active === false) {
                    this.blockAccess("Acesso Suspenso", "Entre em contato com o suporte financeiro.");
                    return;
                } 

                // 2. BLOQUEIO OPERACIONAL (Loja Fechada)
                // Se is_open for false (ou undefined) E o usuário for FUNCIONÁRIO
                // O Dono (owner) sempre passa.
                // Se is_open for undefined (sistema novo), consideramos fechado por segurança ou tratamos como true.
                // Aqui vou tratar undefined como true (aberto) para não travar lojas antigas, 
                // mas assim que você salvar pela primeira vez, valerá o status.
                const isRestaurantOpen = data.is_open !== false; // Default true

                if (!isRestaurantOpen && this.userRole === 'employee') {
                    this.blockAccess("Restaurante Fechado", "O expediente ainda não começou ou já encerrou.");
                    return;
                }

                // SE PASSOU POR TUDO:
                // Se a tela de bloqueio estiver visível, recarrega para liberar
                if (document.getElementById('saas-blocked-screen')) {
                    window.location.reload();
                }

                // Dispara evento customizado para o Admin atualizar o botão visualmente
                window.dispatchEvent(new CustomEvent('restaurantStatusChanged', { detail: { isOpen: isRestaurantOpen } }));

            }
        }, (error) => console.error("Status check error:", error));
    }

    blockAccess(msg = "Acesso Suspenso", subMsg = "Acesso restrito temporariamente.") {
        if (document.getElementById('saas-blocked-screen')) {
             // Se já existe, só atualiza os textos
             document.getElementById('block-title').innerText = msg;
             document.getElementById('block-desc').innerText = subMsg;
             return;
        }
        document.body.innerHTML = `
            <div id="saas-blocked-screen" style="
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: #f8fafc; z-index: 999999; display: flex;
                flex-direction: column; align-items: center; justify-content: center;
                font-family: -apple-system, system-ui, sans-serif; text-align: center; padding: 20px;
            ">
                <div style="font-size: 4rem; margin-bottom: 20px;">🛑</div>
                <h1 id="block-title" style="color: #ef4444; margin: 0 0 10px 0;">${msg}</h1>
                <p id="block-desc" style="color: #64748b; max-width: 400px; line-height: 1.5;">
                    ${subMsg}
                </p>
                <div style="margin-top: 30px; padding: 10px 20px; background: #e2e8f0; border-radius: 6px; font-family: monospace; color: #475569;">
                    ID: ${this.restaurantId}
                </div>
                <button onclick="window.location.reload()" style="margin-top: 20px; padding: 10px 20px; cursor: pointer;">Tentar Novamente</button>
            </div>
        `;
        // throw new Error("BLOQUEIO ATIVO"); // Removi o throw error para não quebrar o JS no console, o HTML overlay já resolve.
    }

    async toggleOperationStatus(isOpen) {
        if (!this.restaurantId) return;
        await updateDoc(doc(this.db, "restaurants", this.restaurantId), {
            is_open: isOpen
        });
    }

    // =========================================================================
    // MANUTENÇÃO AUTOMÁTICA
    // =========================================================================
    async checkAndRunMaintenance() {
        const lastRun = localStorage.getItem(`maintenance_last_run_${this.restaurantId}`);
        const today = new Date().toDateString();
        if (lastRun === today) return;

        const config = await this.getRestaurantConfig();
        const retentionDays = config.retentionDays || DEFAULT_RETENTION_DAYS; 
        this.cleanupOldOrders(retentionDays).then(() => localStorage.setItem(`maintenance_last_run_${this.restaurantId}`, today));
    }

    // =========================================================================
    // MANUTENÇÃO AUTOMÁTICA (MODIFICADO)
    // =========================================================================

    async cleanupOldOrders(analyticsRetentionDays) {
        // Configurações de segurança
        if (!analyticsRetentionDays || analyticsRetentionDays < 1) analyticsRetentionDays = 30;

        // 1. DATA DE CORTE PARA PEDIDOS (ORDERS)
        // A lógica aqui é: Apagar TUDO que for menor que "Hoje 00:00"
        // Ou seja, mantém apenas os pedidos do dia atual.
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        // 2. DATA DE CORTE PARA HISTÓRICO (ANALYTICS)
        // Mantém o histórico baseado na configuração (ex: 30 dias)
        const analyticsCutoffDate = new Date();
        analyticsCutoffDate.setDate(analyticsCutoffDate.getDate() - analyticsRetentionDays);
        const analyticsCutoffString = analyticsCutoffDate.toISOString().split('T')[0]; // YYYY-MM-DD

        let totalDeleted = 0;
        const BATCH_SIZE = 400;

        console.log(`[Manutenção] Limpando Ordens anteriores a: ${startOfToday.toLocaleString()}`);
        console.log(`[Manutenção] Limpando Analytics anteriores a: ${analyticsCutoffString}`);

        try {
            // --- FASE 1: Limpar PEDIDOS (orders) ---
            // Critério: Tudo que foi criado ANTES de hoje a meia-noite
            while (true) {
                const q = query(
                    collection(this.db, "orders"), 
                    where("restaurant_id", "==", this.restaurantId),
                    where("created_at", "<", startOfToday), // <--- MUDANÇA AQUI: Usa o início do dia
                    limit(BATCH_SIZE)
                );

                const snapshot = await getDocs(q);
                if (snapshot.empty) break;

                const batch = writeBatch(this.db);
                snapshot.docs.forEach((doc) => {
                    batch.delete(doc.ref);
                    totalDeleted++;
                });

                await batch.commit();
                console.log(`[Manutenção] Lote de ordens antigas excluído.`);
                await new Promise(resolve => setTimeout(resolve, 100)); 
            }

            // --- FASE 2: Limpar ANALYTICS (daily_analytics) ---
            // Critério: Respeita os dias de retenção (ex: apaga só o que for mais velho que 30 dias)
            while (true) {
                const q = query(
                    collection(this.db, "daily_analytics"), 
                    where("restaurant_id", "==", this.restaurantId),
                    where("date", "<", analyticsCutoffString),
                    limit(BATCH_SIZE)
                );

                const snapshot = await getDocs(q);
                if (snapshot.empty) break;

                const batch = writeBatch(this.db);
                snapshot.docs.forEach((doc) => {
                    batch.delete(doc.ref);
                    totalDeleted++;
                });

                await batch.commit();
                console.log(`[Manutenção] Lote de analytics antigos excluído.`);
                await new Promise(resolve => setTimeout(resolve, 100));
            }

        } catch (e) {
            console.error("Falha na limpeza automática:", e);
        }
        
        return totalDeleted;
    }

    // =========================================================================
    // MÉTODOS DO SUPER ADMIN
    // =========================================================================
    async getAllRestaurants() {
        const q = query(collection(this.db, "restaurants"));
        const querySnapshot = await getDocs(q);
        const clients = [];
        querySnapshot.forEach((doc) => clients.push({ id: doc.id, ...doc.data() }));
        return clients.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    }

    async createRestaurant(slug, name, retentionDays = DEFAULT_RETENTION_DAYS) {
        await setDoc(doc(this.db, "restaurants", slug), {
            restaurant_id: slug, 
            name: name, 
            created_at: new Date(), 
            active: true,
            
            is_open: false,
            
            config_ops: { 
                taxa_servico: 0, 
                retention_days: parseInt(retentionDays) 
            }
        });
    }

    async toggleRestaurantStatus(i, s) { await updateDoc(doc(this.db, "restaurants", i), { active: s }); }
    async updateRetentionPolicy(i, d) { await updateDoc(doc(this.db, "restaurants", i), { 'config_ops.retention_days': parseInt(d) }); }
    async countClientData(id) {
        let t=0; for(const c of ['products','categories','orders','users']) { const s=await getCountFromServer(query(collection(this.db,c),where("restaurant_id","==",id))); t+=s.data().count; } return t;
    }
    async wipeClientData(clientId, progressCallback) {
        // 1. Limpa usuários (para impedir login imediato)
        if(progressCallback) progressCallback("Removendo usuários vinculados...");
        const usersQ = query(collection(this.db, "users"), where("restaurant_id", "==", clientId));
        const usersSnap = await getDocs(usersQ);
        if(!usersSnap.empty) {
            const b = writeBatch(this.db);
            usersSnap.forEach(d => b.delete(d.ref));
            await b.commit();
        }

        // 2. Limpa dados operacionais e financeiros
        // ADICIONADO: 'daily_analytics' na lista
        const collectionsToClean = ['products', 'categories', 'orders', 'daily_analytics'];
        const BATCH_SIZE = 400; 
        
        for (const colName of collectionsToClean) {
            if(progressCallback) progressCallback(`Limpando ${colName}...`);
            while (true) {
                const q = query(collection(this.db, colName), where("restaurant_id", "==", clientId), limit(BATCH_SIZE));
                const snapshot = await getDocs(q);
                if (snapshot.empty) break;
                
                const batch = writeBatch(this.db);
                let count = 0;
                snapshot.docs.forEach((doc) => { 
                    batch.delete(doc.ref); 
                    count++; 
                });
                
                await batch.commit();
                // Pequena pausa para não estourar quota de escrita rápida
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }

        // 3. Remove o registro do restaurante
        if(progressCallback) progressCallback("Removendo cadastro da empresa...");
        await deleteDoc(doc(this.db, "restaurants", clientId));
    }

    // =========================================================================
    // ADMIN DO CLIENTE
    // =========================================================================
    async getRestaurantConfig() {
        try {
            const q = query(collection(this.db, "restaurants"), where("restaurant_id", "==", this.restaurantId));
            const s = await getDocs(q);
            
            // CORREÇÃO 1: Se não encontrou restaurante, retornamos isOpen: true (padrão)
            // Antes você tentava acessar 'd.is_open', mas 'd' não existia aqui.
            if(s.empty) {
                return { serviceFeePercentage: 0, retentionDays: 30, restaurantName: "Não Encontrado", isOpen: true };
            }
            
            // Aqui definimos 'd'
            const d = s.docs[0].data();
            
            return { 
                serviceFeePercentage: d.config_ops?.taxa_servico || 0, 
                docId: s.docs[0].id, 
                restaurantName: d.name, 
                retentionDays: d.config_ops?.retention_days || 30,
                isOpen: d.is_open !== false // Se for undefined, considera aberto
            };
        } catch (e) { 
            // CORREÇÃO 2: Em caso de erro, retornamos isOpen: true (padrão)
            // Antes você tentava acessar 'd.is_open', mas 'd' não existe no bloco catch.
            console.error("Erro config:", e);
            return { serviceFeePercentage: 0, docId: null, restaurantName: "Erro", retentionDays: 30, isOpen: true }; 
        }
    }
    async updateServiceFee(id, f) { await updateDoc(doc(this.db,"restaurants",id),{'config_ops.taxa_servico':f}); }

    listenToAllProducts(cb) { return onSnapshot(query(collection(this.db,"products"),where("restaurant_id","==",this.restaurantId)),s=>{const m=[];s.forEach(d=>m.push({...d.data(),id:d.id}));cb(m);}); }
    listenToCategories(cb) { return onSnapshot(query(collection(this.db,"categories"),where("restaurant_id","==",this.restaurantId)),s=>{const c=[];s.forEach(d=>c.push({...d.data(),id:d.id}));c.sort((a,b)=>a.name.localeCompare(b.name));cb(c);}); }
    async saveCategory(n) { 
        const q = query(collection(this.db,"categories"),where("restaurant_id","==",this.restaurantId),where("name","==",n)); 
        if(!(await getDocs(q)).empty)throw new Error("Categoria já existe!"); 
        await addDoc(collection(this.db,"categories"),{restaurant_id:this.restaurantId,name:n.trim().toLowerCase()}); 
    }
    async deleteCategory(id) { await deleteDoc(doc(this.db,"categories",id)); }
    
    async saveProduct(data) {
        const p = { name: data.name, price: parseFloat(data.price), category: data.category, available: data.available === "true" || data.available === true, restaurant_id: this.restaurantId };
        if(data.id) await updateDoc(doc(this.db,"products",data.id), p);
        else await addDoc(collection(this.db,"products"), p);
    }
    async deleteProduct(id) { await deleteDoc(doc(this.db,"products",id)); }

    // =========================================================================
    // OPERACIONAL
    // =========================================================================
    getMenu(cb) { return onSnapshot(query(collection(this.db,"products"),where("restaurant_id","==",this.restaurantId),where("available","==",true)),s=>{const m=[];s.forEach(d=>m.push({...d.data(),id:d.id}));cb(m);}); }
    
    listenToTableOrders(t,cb) { 
        return onSnapshot(query(collection(this.db,"orders"),where("restaurant_id","==",this.restaurantId),where("table_number","==",parseInt(t))),s=>{const o=[];s.forEach(d=>{const v=d.data();if(v.status!=='paid'&&v.status!=='finalizado'&&v.status!=='cancelled')o.push({...v,id:d.id});});o.sort((a,b)=>(b.created_at?.toMillis||0)-(a.created_at?.toMillis||0));cb(o);}); 
    }
    
    listenToReadyOrders(cb) {
        return onSnapshot(query(collection(this.db,"orders"),where("restaurant_id","==",this.restaurantId),where("status","==","ready")),s=>{const o=[];s.forEach(d=>o.push({...d.data(),id:d.id}));o.sort((a,b)=>(a.created_at?.toMillis||0)-(b.created_at?.toMillis||0));cb(o);});
    }
    
    async createOrder(t,i,tot) { return await addDoc(collection(this.db,"orders"),{restaurant_id:this.restaurantId,table_number:parseInt(t),status:"pending",items:i,total_amount:tot,created_at:new Date(),is_modified:false}); }
    async updateOrder(id,i,tot) { await updateDoc(doc(this.db,"orders",id),{items:i,total_amount:tot,status:"pending",is_modified:true,modified_at:new Date()}); }
    async cancelOrder(id) { await updateDoc(doc(this.db,"orders",id),{status:"cancelled",cancelled_at:new Date()}); }
    listenToSales(d,cb,errCb) { let q=query(collection(this.db,"orders"),where("restaurant_id","==",this.restaurantId),where("status","==","paid")); if(d)q=query(q,where("created_at",">=",d)); return onSnapshot(q,s=>{const v=[];s.forEach(d=>v.push({id:d.id,...d.data()}));v.sort((a,b)=>(a.created_at?.toMillis||0)-(b.created_at?.toMillis||0));cb(v);},errCb); }
    // HISTÓRICO DO CAIXA (Pagos + Finalizados/Cancelados)
    listenToHistory(startDate, callback, errorCallback) {
        let q = query(
            collection(this.db, "orders"), 
            where("restaurant_id", "==", this.restaurantId),
            where("status", "in", ["paid", "finalizado"]) // Busca ambos
        );

        if (startDate) {
            q = query(q, where("created_at", ">=", startDate));
        }

        return onSnapshot(q, (snapshot) => {
            const history = [];
            snapshot.forEach((doc) => history.push({ id: doc.id, ...doc.data() }));
            // Ordena por data (mais recente primeiro)
            history.sort((a, b) => (b.created_at?.toMillis || 0) - (a.created_at?.toMillis || 0));
            callback(history);
        }, (error) => {
            console.error("History Error:", error);
            if (errorCallback) errorCallback(error);
        });
    }
    listenToOrders(cb) { 
        return onSnapshot(query(collection(this.db,"orders"),where("restaurant_id","==",this.restaurantId)),s=>{const o=[];s.forEach(d=>{const v=d.data();if(v.status!=='paid'&&v.status!=='finalizado')o.push({...v,id:d.id});});o.sort((a,b)=>(a.created_at?.toMillis||0)-(a.created_at?.toMillis||0));cb(o);}); 
    }
    
    // =========================================================================
    // DASHBOARD: ESCRITA E LEITURA OTIMIZADAS
    // =========================================================================

    // 1. GATILHO: Atualiza status e dispara analytics se for PAGO
    async updateOrderStatus(orderId, newStatus) {
        const orderRef = doc(this.db, "orders", orderId);
        await updateDoc(orderRef, { status: newStatus });

        // SE O PEDIDO FOI PAGO, DISPARA A GRAVAÇÃO AGREGADA
        if (newStatus === 'paid') {
            this.updateAnalytics(orderId).catch(console.error);
        }
    }

    // 2. GRAVAÇÃO: Salva dados no documento do dia (daily_analytics)
    async updateAnalytics(orderId) {
        try {
            const orderRef = doc(this.db, "orders", orderId);
            const orderSnap = await getDoc(orderRef);
            
            if (!orderSnap.exists()) return;
            const order = orderSnap.data();

            // Evita duplicidade
            if (order.analytics_processed) return;

            // ID do Documento: "ID-DO-RESTAURANTE_YYYY-MM-DD"
            // Exemplo: c1_2025-11-21
            const today = new Date().toISOString().split('T')[0]; 
            const analyticsId = `${this.restaurantId}_${today}`;
            
            // Referência direta à coleção RAIZ
            const analyticsRef = doc(this.db, "daily_analytics", analyticsId);

            // Prepara incrementos
            const catUpdates = {};
            const prodUpdates = {};
            
            if (order.items && Array.isArray(order.items)) {
                order.items.forEach(item => {
                    // --- CORREÇÃO AQUI ---
                    
                    // Categoria: Remove pontos, troca espaços por _ e mantém acentos
                    const safeCat = (item.category || 'outros').toLowerCase().trim()
                        .replace(/\./g, '')      // Remove pontos (Proibido no Firestore)
                        .replace(/\//g, '-')     // Troca barras por traço
                        .replace(/\s+/g, '_');   // Troca espaços por underline

                    // Produto: Mesma lógica (Mantém o 'ç', 'ã', etc)
                    const safeProd = item.name.toLowerCase().trim()
                        .replace(/\./g, '') 
                        .replace(/\//g, '-')
                        .replace(/\s+/g, '_');
                    
                    // Incrementa categoria
                    catUpdates[`categories.${safeCat}`] = increment(item.qty);
                    // Incrementa produto
                    prodUpdates[`products.${safeProd}`] = increment(item.qty);
                });
            }

            console.log(`Atualizando Analytics: ${analyticsId}`, { total: order.total_amount });

            // Salva com merge
            await setDoc(analyticsRef, {
                restaurant_id: this.restaurantId,
                date: today, 
                total_revenue: increment(order.total_amount),
                order_count: increment(1),
                last_updated: new Date(),
                ...catUpdates,
                ...prodUpdates
            }, { merge: true });

            // Marca pedido como processado
            await updateDoc(orderRef, { analytics_processed: true });

        } catch (e) { console.error("Erro analytics:", e); }
    }

    // 3. LEITURA: Busca documentos agregados
    listenToAnalytics(startDate, callback, errorCallback) {
        const strDate = startDate.toISOString().split('T')[0];
        console.log(`Buscando Analytics desde: ${strDate} para ${this.restaurantId}`);
        
        const q = query(
            collection(this.db, "daily_analytics"),
            where("restaurant_id", "==", this.restaurantId),
            where("date", ">=", strDate)
        );

        return onSnapshot(q, (snapshot) => {
            const dailyData = [];
            snapshot.forEach((doc) => {
                const data = doc.data();
                console.log("Dado Analytics Recebido:", data); // Debug
                dailyData.push(data);
            });
            
            dailyData.sort((a, b) => a.date.localeCompare(b.date));
            callback(dailyData);
        }, (error) => {
            console.error("Erro de Permissão ou Índice:", error);
            if (errorCallback) errorCallback(error);
        });
    }
}