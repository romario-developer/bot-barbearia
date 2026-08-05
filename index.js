// ==========================================
// 🚨 TRATAMENTO DE ERROS GLOBAIS
// ==========================================
process.on('uncaughtException', (err) => {
    console.error('CRASH FATAL (uncaughtException):', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('REJEIÇÃO NÃO TRATADA:', reason);
});

// ==========================================
// 📦 IMPORTAÇÕES E CONFIGURAÇÕES INICIAIS
// ==========================================
// Foi adicionado o 'List' aqui para o menu interativo
const { Client, LocalAuth, List } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { PrismaClient } = require('@prisma/client');
const express = require('express');
const cors = require('cors');

const prisma = new PrismaClient();
const app = express();
const PORTA_API = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ==========================================
// 🧠 ESTADOS E VARIÁVEIS GLOBAIS
// ==========================================
const estadosUsuarios = {};
const dadosTemporarios = {};
const gerandoAgendaLock = {}; 
const lembretesEnviados = new Set();
const feedbacksEnviados = new Set(); 
const filaDeEspera = {}; 

const numerosBloqueados = ['213610265579641@lid'];
const NUMERO_DO_BARBEIRO = '5573982105264'; 

// ==========================================
// 🛠️ SERVIÇOS E LÓGICA DE NEGÓCIO
// ==========================================
function avisarFila(dataVaga) {
    if (filaDeEspera[dataVaga] && filaDeEspera[dataVaga].length > 0) {
        const msgFila = `🚨 *VAGA LIBERADA!*\n\nSurgiu um horário disponível para o dia *${dataVaga}*!\n\nComo você está em nossa fila de espera, caso ainda tenha interesse, por favor, envie um *"Oi"* aqui o quanto antes para garantir essa vaga.`;
        
        filaDeEspera[dataVaga].forEach(numero => {
            client.sendMessage(numero + '@c.us', msgFila).catch(() => {});
        });
    }
}

function validarDataInput(texto) {
    const limpo = texto.replace(/\D/g, ''); 
    let d, m, y;
    const hoje = new Date();
    const anoAtual = hoje.getFullYear();

    if (limpo.length === 4) { 
        d = limpo.substring(0, 2); m = limpo.substring(2, 4); y = anoAtual.toString();
    } else if (limpo.length === 6) { 
        d = limpo.substring(0, 2); m = limpo.substring(2, 4); y = '20' + limpo.substring(4, 6);
    } else if (limpo.length === 8) { 
        d = limpo.substring(0, 2); m = limpo.substring(2, 4); y = limpo.substring(4, 8);
    } else {
        return null; 
    }

    const dia = parseInt(d); const mes = parseInt(m); const ano = parseInt(y);
    if (dia < 1 || dia > 31 || mes < 1 || mes > 12) return null;

    const dataInput = new Date(ano, mes - 1, dia);
    const hojeZerado = new Date(); hojeZerado.setHours(0, 0, 0, 0);

    if (dataInput < hojeZerado) return { erro: 'PASSADO' };

    return { 
        string: `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${ano}`, 
        diaSemana: dataInput.getDay() 
    };
}

function gerarHorarios(horaInicio, horaFim, intervaloMinutos) {
    let slots = [];
    let [inicioH, inicioM] = horaInicio.split(':').map(Number);
    let [fimH, fimM] = horaFim.split(':').map(Number);

    let tempoAtual = new Date(2000, 0, 1, inicioH, inicioM);
    let tempoFinal = new Date(2000, 0, 1, fimH, fimM);

    if (tempoFinal <= tempoAtual) tempoFinal.setDate(tempoFinal.getDate() + 1);

    // Revertido para bloquear apenas até as 13:15. As 13:30 estará livre!
    const horariosAlmoco = ["11:45", "12:00", "12:15", "12:30", "12:45", "13:00", "13:15"];

    while (tempoAtual < tempoFinal) {
        let h = tempoAtual.getHours().toString().padStart(2, '0');
        let m = tempoAtual.getMinutes().toString().padStart(2, '0');
        let horaAtual = `${h}:${m}`;
        
        let isAlmoco = horariosAlmoco.includes(horaAtual);

        slots.push({ 
            hora: horaAtual, 
            status: isAlmoco ? "ocupado" : "disponivel", 
            cliente: isAlmoco ? "ALMOÇO" : null, 
            servico: isAlmoco ? "Pausa" : null, 
            whatsapp: null 
        });
        
        tempoAtual.setMinutes(tempoAtual.getMinutes() + intervaloMinutos);
    }
    return slots;
}

async function gerarAgendaDoDiaAtual() {
    const dataHoje = new Date().toLocaleDateString('pt-BR');
    const qtdHorarios = await prisma.horario.count({ where: { data: dataHoje } });
    if (qtdHorarios > 0) return; 

    const hoje = new Date().getDay(); 
    let horaInicio = (hoje >= 1 && hoje <= 6) ? '09:00' : null;
    let horaFim = (hoje >= 1 && hoje <= 5) ? '19:00' : (hoje === 6 ? '18:00' : null);

    if (horaInicio) {
        if (!gerandoAgendaLock[dataHoje]) {
            gerandoAgendaLock[dataHoje] = true;
            try {
                const slotsPadrao = gerarHorarios(horaInicio, horaFim, 15); 
                for (const slot of slotsPadrao) {
                    await prisma.horario.create({ data: { ...slot, data: dataHoje } });
                }
            } finally {
                delete gerandoAgendaLock[dataHoje];
            }
        }
    }
}

// ==========================================
// ⏰ ROTINAS AUTOMÁTICAS (CRON JOBS)
// ==========================================
function iniciarRotinaDiaria() {
    const agora = new Date();
    const amanha = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + 1, 0, 1, 0); 
    const msAteMeiaNoite = amanha - agora;

    setTimeout(async () => {
        const ontem = new Date(agora); ontem.setDate(ontem.getDate() - 1);
        await prisma.horario.deleteMany({ where: { data: ontem.toLocaleDateString('pt-BR') } }); 
        
        lembretesEnviados.clear();
        feedbacksEnviados.clear(); 
        await gerarAgendaDoDiaAtual(); 
        iniciarRotinaDiaria(); 
    }, msAteMeiaNoite);
}

function iniciarRotinaAutomativa() {
    setInterval(async () => {
        const agora = new Date();
        const horaAtual = agora.getHours();
        const minAtual = agora.getMinutes();

        // 1. Resumo Diário às 08:30
        if (horaAtual === 8 && minAtual === 30) {
            enviarResumoParaBarbeiro();
        }

        // 2. Lembretes de 15 min (Futuro)
        const futuro = new Date(agora.getTime() + 15 * 60000);
        const dataFuturo = `${String(futuro.getDate()).padStart(2, '0')}/${String(futuro.getMonth() + 1).padStart(2, '0')}/${futuro.getFullYear()}`; 
        const horaAlvoFuturo = `${String(futuro.getHours()).padStart(2, '0')}:${String(futuro.getMinutes()).padStart(2, '0')}`;

        try {
            const reservasFuturas = await prisma.horario.findMany({
                where: { data: dataFuturo, hora: horaAlvoFuturo, status: 'ocupado' }
            });

            for (const reserva of reservasFuturas) {
                if (!reserva.whatsapp || reserva.whatsapp === 'Painel Web') continue;
                if (lembretesEnviados.has(reserva.id)) continue;

                const msg = `🔔 *Lembrete de Agendamento - Jonathan's Barber Shop*\n\nOlá, ${reserva.cliente}! Passando para lembrar do seu agendamento de *${reserva.servico}* hoje às *${reserva.hora}*. Estamos te aguardando! ✂️`;
                await client.sendMessage(reserva.whatsapp + '@c.us', msg);
                lembretesEnviados.add(reserva.id);
            }
        } catch (error) { console.error("❌ Erro no Vigia de Lembretes:", error); }

        // 3. Feedback Pós-venda (2 horas no Passado)
        const passado = new Date(agora.getTime() - 2 * 60 * 60000);
        const dataPassado = `${String(passado.getDate()).padStart(2, '0')}/${String(passado.getMonth() + 1).padStart(2, '0')}/${passado.getFullYear()}`;
        const horaAlvoPassado = `${String(passado.getHours()).padStart(2, '0')}:${String(passado.getMinutes()).padStart(2, '0')}`;

        try {
            const cortesFinalizados = await prisma.horario.findMany({
                where: { data: dataPassado, hora: horaAlvoPassado, status: 'ocupado' }
            });

            for (const corte of cortesFinalizados) {
                if (!corte.whatsapp || corte.whatsapp === 'Painel Web') continue;
                if (feedbacksEnviados.has(corte.id)) continue;

                const chatId = corte.whatsapp + '@c.us';
                const msgFeedback = `Olá, ${corte.cliente}! Esperamos que tenha tido uma excelente experiência com o seu serviço de hoje (✂️ ${corte.servico}).\n\nSua opinião é muito importante para nós! Como você avalia nosso atendimento?\nPor favor, responda com uma nota de *1 a 5* ⭐.`;
                
                await client.sendMessage(chatId, msgFeedback);
                estadosUsuarios[chatId] = 'AGUARDANDO_AVALIACAO';
                feedbacksEnviados.add(corte.id);
            }
        } catch (error) { console.error("❌ Erro no Feedback:", error); }

    }, 60 * 1000);
}

async function enviarResumoParaBarbeiro() {
    const dataHoje = new Date().toLocaleDateString('pt-BR');
    
    const reservas = await prisma.horario.findMany({
        where: { data: dataHoje, status: 'ocupado' },
        orderBy: { hora: 'asc' }
    });

    let resumo = `📅 *Resumo da Agenda para hoje (${dataHoje})*\n\n`;
    if (reservas.length === 0) {
        resumo += "Nenhum agendamento para hoje ainda.";
    } else {
        reservas.forEach(r => { resumo += `🕒 ${r.hora} - ${r.cliente} (${r.servico})\n`; });
    }

    try {
        const idVerificado = await client.getNumberId(NUMERO_DO_BARBEIRO);
        if (idVerificado) await client.sendMessage(idVerificado._serialized, resumo);
    } catch (err) { console.error("Erro ao enviar resumo:", err.message); }
}

// ==========================================
// 🌐 ROTAS DA API (EXPRESS)
// ==========================================
app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/api/servicos', async (req, res) => {
    try {
        const servicos = await prisma.servico.findMany({ orderBy: { id: 'asc' } });
        res.json(servicos);
    } catch (error) { res.status(500).json({ erro: "Erro ao buscar serviços" }); }
});

app.post('/api/servicos', async (req, res) => {
    try {
        const { nome, preco, duracao } = req.body;
        const novoServico = await prisma.servico.create({ data: { nome, preco, duracao: parseInt(duracao) || 30 } });
        res.status(201).json(novoServico);
    } catch (error) { res.status(500).json({ erro: "Erro ao criar serviço" }); }
});

app.delete('/api/servicos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.servico.delete({ where: { id: parseInt(id) } });
        res.json({ mensagem: "Serviço removido" });
    } catch (error) { res.status(500).json({ erro: "Erro ao remover serviço" }); }
});

app.get('/api/horarios', async (req, res) => {
    try {
        const { data } = req.query;
        const filtro = data ? { data: data } : {};
        let horarios = await prisma.horario.findMany({ where: filtro, orderBy: { id: 'asc' } });

        if (data && horarios.length > 0) {
            const horasUnicas = new Set();
            let temDuplicata = false;
            for (const h of horarios) {
                if (horasUnicas.has(h.hora)) { temDuplicata = true; break; }
                horasUnicas.add(h.hora);
            }
            if (temDuplicata) {
                await prisma.horario.deleteMany({ where: filtro });
                horarios = []; 
            }
        }

        if (data && horarios.length === 0) {
            if (gerandoAgendaLock[data]) return res.json([]); 
            gerandoAgendaLock[data] = true;

            try {
                const [d, m, y] = data.split('/');
                const dataObj = new Date(y, m - 1, d);
                
                if (dataObj.getDay() !== 0) { 
                    let hFim = (dataObj.getDay() === 6) ? '18:00' : '19:00'; 
                    const novosSlots = gerarHorarios('09:00', hFim, 15);
                    for (const slot of novosSlots) {
                        await prisma.horario.create({ data: { ...slot, data } });
                    }
                    horarios = await prisma.horario.findMany({ where: filtro, orderBy: { id: 'asc' } });
                }
            } finally { delete gerandoAgendaLock[data]; }
        }
        res.json(horarios);
    } catch (error) { res.status(500).json({ erro: "Erro ao buscar agenda" }); }
});

app.put('/api/horarios/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, cliente, servico } = req.body;
        
        const horarioAntigo = await prisma.horario.findUnique({ where: { id: parseInt(id) } });
        const horarioAtualizado = await prisma.horario.update({
            where: { id: parseInt(id) },
            data: {
                status,
                cliente: status === 'disponivel' ? null : (cliente || 'Presencial/Balcão'),
                servico: status === 'disponivel' ? null : (servico || 'Não especificado'),
                whatsapp: status === 'disponivel' ? null : 'Painel Web'
            }
        });

        if (status === 'disponivel' && horarioAntigo && horarioAntigo.status === 'ocupado') {
            avisarFila(horarioAtualizado.data);
        }
        res.json(horarioAtualizado);
    } catch (error) { res.status(500).json({ erro: "Erro ao atualizar horário" }); }
});

app.post('/api/bot/status', async (req, res) => {
    try {
        const { ativo } = req.body;
        await prisma.configuracao.upsert({
            where: { id: 1 },
            update: { botAtivo: ativo },
            create: { id: 1, botAtivo: ativo }
        });
        res.json({ mensagem: "Status alterado" });
    } catch (error) { res.status(500).json({ erro: "Erro ao mudar status" }); }
});

app.get('/api/bot/status', async (req, res) => {
    const config = await prisma.configuracao.findUnique({ where: { id: 1 } });
    res.json({ ativo: config ? config.botAtivo : true });
});

// ==========================================
// 🤖 CLIENTE DO WHATSAPP (BOT)
// ==========================================
const client = new Client({
    authStrategy: new LocalAuth(),
    webVersionCache: { type: 'none' },
    puppeteer: {
        headless: true, 
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-extensions']
    }
});

client.on('loading_screen', (percent, message) => {
    console.log(`⏳ [Bot]: Carregando WhatsApp... ${percent}% | ${message}`);
});
client.on('qr', (qr) => { qrcode.generate(qr, { small: true }); });

client.on('ready', async () => {
    console.log('\n🚀 [Bot]: Sistema Múltiplos Serviços Iniciado!\n');
    await gerarAgendaDoDiaAtual();
    iniciarRotinaDiaria();
    iniciarRotinaAutomativa(); 
});

client.on('message', async (msg) => {
    const chatId = msg.from; 

    // 🛡️ ESCUDOS ANTI-LIXO E MENSAGENS DE SISTEMA
    const tiposDeSistema = ['e2e_notification', 'protocol', 'call_log', 'gp2', 'notification_template'];
    if (tiposDeSistema.includes(msg.type)) return; 
    if (chatId.includes('@newsletter') || chatId.endsWith('@g.us') || chatId === 'status@broadcast') return;

    // 🛑 ESCUDO DO BARBEIRO
    if (msg.fromMe) return; 
    if (chatId === NUMERO_DO_BARBEIRO + '@c.us') return; 
    if (chatId === '213610265579641@lid') return; 
    if (numerosBloqueados.includes(chatId)) return;

    console.log(`\n🚨 [RAIO-X] Mensagem recebida! De: ${chatId} | Texto: ${msg.body}`);

    const contato = await msg.getContact();
    const numeroReal = contato.number || ""; 
    const nomeWhatsApp = contato.pushname || "Cliente";

    if (msg.hasMedia || msg.type === 'audio' || msg.type === 'ptt') {
        return msg.reply('🤖 Olá! Sou o assistente virtual da barbearia. No momento, não consigo processar áudios ou imagens. Por favor, envie sua mensagem em texto para que eu possa ajudar!');
    }

    const textoRecebido = msg.body.trim().toLowerCase();
    if (textoRecebido.startsWith('!')) return; 

    if (textoRecebido === 'cancelar' || msg.body === '❌ Cancelar atendimento') {
        delete estadosUsuarios[chatId];
        delete dadosTemporarios[chatId];
        return msg.reply('❌ Seu atendimento foi cancelado. Caso deseje iniciar novamente, basta enviar um "Oi". Estaremos à disposição!');
    }

    // PASSO 0.5: PROCESSAR AVALIAÇÃO DE FEEDBACK
    if (estadosUsuarios[chatId] === 'AGUARDANDO_AVALIACAO') {
        const nota = textoRecebido.trim();
        if (['1', '2', '3', '4', '5'].includes(nota)) {
            delete estadosUsuarios[chatId]; 
            if (nota === '5' || nota === '4') {
                return msg.reply(`⭐⭐⭐⭐⭐\nMuito obrigado pela sua avaliação, ${nomeWhatsApp}! Ficamos imensamente felizes que tenha gostado do nosso trabalho. Será um prazer recebê-lo(a) novamente. Até a próxima! 🚀`);
            } else {
                try {
                    const idVerificado = await client.getNumberId(NUMERO_DO_BARBEIRO);
                    if (idVerificado) await client.sendMessage(idVerificado._serialized, `⚠️ *ALERTA DE QUALIDADE!*\n\nO cliente *${nomeWhatsApp}* avaliou o último atendimento com nota *${nota}*.`);
                } catch (err) {}
                return msg.reply(`Obrigado pelo seu feedback sincero, ${nomeWhatsApp}! Sempre buscamos melhorar nossos serviços. Esperamos te surpreender positivamente na próxima visita! 🙌`);
            }
        } else {
            delete estadosUsuarios[chatId];
        }
    }

    // ===============================================
    // 🔘 NOVO MENU INTERATIVO (USANDO LIST)
    // ===============================================
    // PASSO 1: MENU INICIAL
    if (!estadosUsuarios[chatId] || estadosUsuarios[chatId] === 'INICIO') {
        const servicos = await prisma.servico.findMany({ orderBy: { id: 'asc' } });
        if (servicos.length === 0) return msg.reply('⚠️ No momento estamos atualizando nossa lista de serviços. Por favor, tente novamente em alguns instantes.');

        estadosUsuarios[chatId] = 'ESCOLHENDO_SERVICO';
        
        let rowsServicos = servicos.map((s, index) => ({
            id: `servico_${s.id}`,
            title: s.nome,
            description: `💰 R$ ${s.preco} | ⏳ ${s.duracao} min`
        }));
        
        let secoes = [
            {
                title: 'Serviços de Cabelo e Barba',
                rows: rowsServicos
            },
            {
                title: 'Outras Opções',
                rows: [{ id: 'cancelar', title: '❌ Cancelar atendimento' }]
            }
        ];

        let mensagem = `👋 Olá, ${nomeWhatsApp}! Seja muito bem-vindo(a) à *Jonathan's Barber Shop*.\n\nÉ um prazer ter você aqui. Como podemos te ajudar hoje?`;
        let rodape = 'Toque no botão acima para abrir o menu.\n(Se o botão não aparecer, envie o NÚMERO do serviço que deseja).';

        const listaServicos = new List(mensagem, 'Ver Serviços', secoes, 'Agendamento Barbearia', rodape);
        return client.sendMessage(msg.from, listaServicos);
    }

    // PASSO 2: ESCOLHENDO O SERVIÇO
    if (estadosUsuarios[chatId] === 'ESCOLHENDO_SERVICO') {
        
        if (textoRecebido === '0' || msg.body === '❌ Cancelar atendimento') {
            if (!numeroReal) { delete estadosUsuarios[chatId]; return msg.reply('❌ Não conseguimos identificar o seu número.'); }
            const reservas = await prisma.horario.findMany({ where: { whatsapp: numeroReal, status: 'ocupado' } });
            
            if (reservas.length === 0) { delete estadosUsuarios[chatId]; return msg.reply('❌ Você não possui nenhum agendamento ativo.'); }

            const dataCancelada = reservas[0].data; 

            await prisma.horario.updateMany({
                where: { whatsapp: numeroReal, status: 'ocupado' },
                data: { status: 'disponivel', cliente: null, servico: null, whatsapp: null }
            });

            avisarFila(dataCancelada);

            delete estadosUsuarios[chatId];
            return msg.reply('✅ *Agendamento Cancelado!*\n\nSeus horários foram liberados com sucesso. Caso precise, estaremos à disposição! 👋');
        }

        const servicos = await prisma.servico.findMany({ orderBy: { id: 'asc' } });
        
        let nomesEscolhidos = [];
        let tempoTotal = 0;

        // Tenta achar o serviço pelo nome exato que o cliente clicou na lista
        const servicoSelecionadoPelaLista = servicos.find(s => s.nome.toLowerCase() === textoRecebido);

        if (servicoSelecionadoPelaLista) {
            nomesEscolhidos.push(servicoSelecionadoPelaLista.nome);
            tempoTotal += (servicoSelecionadoPelaLista.duracao || 30);
        } else {
            // Se o celular não tem suporte à lista e ele digitou números antigos, trata normalmente:
            const numerosDigitados = textoRecebido.match(/\d+/g);
            if (!numerosDigitados || numerosDigitados.length === 0) {
                return msg.reply('❌ Opção inválida. Por favor, toque no botão da lista para escolher ou digite o número do serviço.');
            }

            for (let numStr of numerosDigitados) {
                const index = parseInt(numStr) - 1;
                const servico = servicos[index];
                if (servico) {
                    nomesEscolhidos.push(servico.nome);
                    tempoTotal += (servico.duracao || 30);
                }
            }
        }

        if (nomesEscolhidos.length === 0) return msg.reply('❌ Opção inválida. Por favor, selecione os serviços corretamente.');

        dadosTemporarios[chatId] = { 
            servicoNome: nomesEscolhidos.join(' + '), 
            blocosNecessarios: Math.ceil(tempoTotal / 15),
            tempoTotal: tempoTotal
        };

        estadosUsuarios[chatId] = 'ESCOLHENDO_DATA';
        return msg.reply(`✅ Excelente escolha! Você selecionou: *${dadosTemporarios[chatId].servicoNome}* (Duração aprox.: ${tempoTotal} min).\n\n📅 *Para qual data você gostaria de agendar?*\n_(Por favor, digite no formato Dia/Mês. Ex: 28/06)_`);
    }

    // PASSO 3: ESCOLHENDO DATA
    if (estadosUsuarios[chatId] === 'ESCOLHENDO_DATA') {
        const infoData = validarDataInput(textoRecebido);
        
        if (!infoData) return msg.reply('❌ Formato inválido. Por favor, envie a data no formato Dia/Mês (ex: 28/06).');
        if (infoData.erro === 'PASSADO') return msg.reply('⏰ A data informada já passou. Por favor, insira uma data válida a partir de hoje.');
        if (infoData.diaSemana === 0) return msg.reply('🗓️ Agradecemos a preferência, mas não temos expediente aos domingos. Por favor, escolha outra data.');

        const dataString = infoData.string;
        dadosTemporarios[chatId].dataEscolhida = dataString;

        let todosHorarios = await prisma.horario.findMany({ where: { data: dataString }, orderBy: { id: 'asc' } });
        
        if (todosHorarios.length === 0) {
            if (!gerandoAgendaLock[dataString]) {
                gerandoAgendaLock[dataString] = true;
                try {
                    let hFim = (infoData.diaSemana === 6) ? '18:00' : '19:00'; 
                    const novosSlots = gerarHorarios('09:00', hFim, 15);
                    for (const slot of novosSlots) {
                        await prisma.horario.create({ data: { ...slot, data: dataString } });
                    }
                } finally { delete gerandoAgendaLock[dataString]; }
            } else {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            todosHorarios = await prisma.horario.findMany({ where: { data: dataString }, orderBy: { id: 'asc' } });
        }

        const blocosNecessarios = dadosTemporarios[chatId].blocosNecessarios;
        let horariosValidos = [];
        
        for (let i = 0; i <= todosHorarios.length - blocosNecessarios; i++) {
            let sequenciaLivre = true;
            for (let j = 0; j < blocosNecessarios; j++) {
                if (todosHorarios[i + j].status !== 'disponivel') {
                    sequenciaLivre = false; break;
                }
            }
            if (sequenciaLivre) horariosValidos.push(todosHorarios[i]);
        }

        const agora = new Date();
        const hojeStr = `${String(agora.getDate()).padStart(2, '0')}/${String(agora.getMonth() + 1).padStart(2, '0')}/${agora.getFullYear()}`;
        
        if (dataString === hojeStr) {
            const minutosAtuais = (agora.getHours() * 60) + agora.getMinutes();
            horariosValidos = horariosValidos.filter(h => {
                const [hora, min] = h.hora.split(':').map(Number);
                const minutosSlot = (hora * 60) + min;
                return minutosSlot > minutosAtuais;
            });
        }

        if (horariosValidos.length === 0) {
            dadosTemporarios[chatId].dataLotada = dataString;
            estadosUsuarios[chatId] = 'FILA_ESPERA';
            return msg.reply(`🗓️ Infelizmente, nossa agenda para o dia *${dataString}* já está totalmente preenchida para o tempo necessário (${dadosTemporarios[chatId].tempoTotal} min).\n\nGostaria de entrar em nossa *Fila de Espera*? Caso surja alguma desistência, nós te avisaremos imediatamente!\n\n*[ 1 ]* - Sim, por favor, me avise.\n*[ 2 ]* - Não, prefiro escolher outra data.`);
        }

        estadosUsuarios[chatId] = 'ESCOLHENDO_HORARIO';
        let menuHorarios = `📅 *Horários Livres para ${dataString}:*\n\n`;
        
        horariosValidos.forEach((h, index) => {
            menuHorarios += `*[ ${index + 1} ]* - ${h.hora}\n`;
        });
        
        dadosTemporarios[chatId].mapaHorarios = horariosValidos.map(h => h.id);
        menuHorarios += `\n👉 Digite o *NÚMERO* do horário desejado.`;
        return msg.reply(menuHorarios);
    }

    // PASSO 3.5: DECISÃO DA FILA DE ESPERA
    if (estadosUsuarios[chatId] === 'FILA_ESPERA') {
        if (textoRecebido === '1') {
            const dataFila = dadosTemporarios[chatId].dataLotada;
            
            if (!filaDeEspera[dataFila]) filaDeEspera[dataFila] = [];
            if (!filaDeEspera[dataFila].includes(numeroReal)) filaDeEspera[dataFila].push(numeroReal);
            
            delete estadosUsuarios[chatId];
            delete dadosTemporarios[chatId];
            return msg.reply(`✅ Perfeito! Seu número foi adicionado à Fila de Espera para o dia *${dataFila}*.\n\nFique de olho no WhatsApp, caso surja uma vaga nós avisaremos imediatamente! 👋`);
        } else {
            estadosUsuarios[chatId] = 'ESCOLHENDO_DATA';
            return msg.reply(`📅 Certo! Para qual *outra data* você gostaria de agendar?\n_(Ex: 28/06)_`);
        }
    }

    // PASSO 4: ESCOLHENDO HORÁRIO
    if (estadosUsuarios[chatId] === 'ESCOLHENDO_HORARIO') {
        const escolhaIndex = parseInt(textoRecebido) - 1;
        const mapaHorarios = dadosTemporarios[chatId].mapaHorarios || [];
        const idHorarioCorreto = mapaHorarios[escolhaIndex];

        const horario = await prisma.horario.findUnique({ where: { id: idHorarioCorreto || -1 } });
        if (!horario) return msg.reply('❌ Horário inválido. Por favor, digite um dos números indicados na lista acima.');

        dadosTemporarios[chatId].horarioId = horario.id;
        dadosTemporarios[chatId].horarioHora = horario.hora;

        estadosUsuarios[chatId] = 'DIGITANDO_NOME';
        return msg.reply(`✅ Quase lá! O horário do dia *${dadosTemporarios[chatId].dataEscolhida}* às *${horario.hora}* foi pré-reservado para você.\n\n👤 Para finalizarmos o agendamento, por favor, digite apenas o seu *PRIMEIRO NOME*:`);
    }

    // PASSO 5: DIGITANDO O NOME E FINALIZANDO
    if (estadosUsuarios[chatId] === 'DIGITANDO_NOME') {
        const nomeDigitado = msg.body.trim(); 
        const dados = dadosTemporarios[chatId];
        const startId = dados.horarioId;
        const blocos = dados.blocosNecessarios;

        const slotsParaOcupar = await prisma.horario.findMany({
            where: { id: { gte: startId, lt: startId + blocos } },
            orderBy: { id: 'asc' }
        });

        const todosLivres = slotsParaOcupar.length === blocos && slotsParaOcupar.every(s => s.status === 'disponivel');

        if (!todosLivres) {
            delete estadosUsuarios[chatId]; delete dadosTemporarios[chatId];
            return msg.reply('⚠️ Pedimos desculpas, mas este horário acabou de ser reservado por outro cliente. Por favor, envie "Oi" para iniciarmos novamente e escolher outro horário.');
        }

        await prisma.horario.updateMany({
            where: { id: { in: slotsParaOcupar.map(s => s.id) } },
            data: { status: 'ocupado', cliente: nomeDigitado, servico: dados.servicoNome, whatsapp: numeroReal }
        });

        const msgCliente = `🎉 *Agendamento Confirmado com Sucesso!*\n\n👤 *Cliente:* ${nomeDigitado}\n✂️ *Serviço(s):* ${dados.servicoNome}\n📅 *Data:* ${dados.dataEscolhida}\n🕒 *Horário:* ${dados.horarioHora}\n\nAgradecemos a preferência e aguardamos você no horário marcado! Até breve.`;
        const msgBarbeiro = `🚨 *NOVO AGENDAMENTO!*\n\n👤 Cliente: *${nomeDigitado}*\n📱 Contato: ${numeroReal}\n✂️ Serviço: ${dados.servicoNome}\n📅 Data: ${dados.dataEscolhida}\n🕒 Horário: *${dados.horarioHora}*`;

        await msg.reply(msgCliente);
        
        try {
            const idVerificado = await client.getNumberId(NUMERO_DO_BARBEIRO);
            if (idVerificado) {
                await client.sendMessage(idVerificado._serialized, msgBarbeiro);
            }
        } catch (err) {
            console.log("Erro ao notificar barbeiro:", err.message);
        }

        delete estadosUsuarios[chatId]; 
        delete dadosTemporarios[chatId];
        return;
    }
});

app.listen(PORTA_API, '0.0.0.0', () => {
    console.log(`🌐 [API]: Servidor Web ativo na porta: ${PORTA_API}`);
    client.initialize();
});