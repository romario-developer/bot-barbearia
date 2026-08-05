// ==========================================
// JONATHAN'S BARBER SHOP - BOT DE AGENDAMENTO
// Fluxo por enquetes clicáveis + fallback numérico
// ==========================================

const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { PrismaClient } = require('@prisma/client');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const prisma = new PrismaClient();
const app = express();
const PORTA_API = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ==========================================
// CONFIGURAÇÕES
// ==========================================
const NUMERO_DO_BARBEIRO = process.env.NUMERO_BARBEIRO || '5573982105264';
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const NOME_BARBEARIA = "Jonathan's Barber Shop";
const BLOCO_MINUTOS = 15;
const HORARIOS_ALMOCO = ['11:45', '12:00', '12:15', '12:30', '12:45', '13:00', '13:15'];
const MAX_OPCOES_ENQUETE = 11; // WhatsApp aceita até 12; deixamos 1 de folga
const MAX_TAMANHO_OPCAO = 90;  // limite seguro por opção de enquete

// ==========================================
// FORMATO DO MENU
//
// false = menu numerado, o cliente digita o número (padrão)
// true  = enquete clicável do WhatsApp
// ==========================================
const USAR_ENQUETES = process.env.USAR_ENQUETES === 'true';

const numerosBloqueados = ['213610265579641@lid'];

// ==========================================
// MODO DE TESTE - LISTA DE NÚMEROS LIBERADOS
//
// Enquanto houver número nesta lista, o bot responde SOMENTE a eles.
// Para liberar o bot para todos os clientes, deixe a lista vazia:
//     const NUMEROS_PERMITIDOS = [];
//
// Pode escrever com ou sem o 55 na frente.
//
// ATENÇÃO: o WhatsApp novo identifica alguns contatos por "LID" (um número
// interno, terminado em @lid) em vez do telefone real. Se o log mostrar
// "número fora da lista" com um @lid, copie esses dígitos e cole aqui também.
// ==========================================
const NUMEROS_PERMITIDOS = (process.env.NUMEROS_PERMITIDOS !== undefined
    ? process.env.NUMEROS_PERMITIDOS.split(',')   // vazio ("") = libera para todos
    : [
        '73991472169',      // telefone
        '9848494243912'     // LID do mesmo aparelho
    ]
).map(n => String(n).replace(/\D/g, '')).filter(Boolean);

function identificadoresDoContato(chatId, contato) {
    return [
        String(chatId || '').split('@')[0],
        contato?.number,
        contato?.id?.user,
        contato?.id?._serialized?.split('@')[0]
    ].map(v => String(v || '').replace(/\D/g, '')).filter(Boolean);
}

function numeroPermitido(chatId, contato) {
    if (NUMEROS_PERMITIDOS.length === 0) return true; // lista vazia = liberado para todos

    const candidatos = identificadoresDoContato(chatId, contato);

    return NUMEROS_PERMITIDOS.some(permitido =>
        candidatos.some(c => c === permitido || c.endsWith(permitido) || permitido.endsWith(c))
    );
}

// ==========================================
// ESTADO EM MEMÓRIA
// ==========================================
const estadosUsuarios = {};
const dadosTemporarios = {};
const gerandoAgendaLock = {};

// Enquetes ativas: messageId da enquete -> { chatId, tipo, opcoes }
const enquetesPorMensagem = {};
// Última enquete enviada por chat (usada no fallback numérico)
const ultimaEnquetePorChat = {};
// Evita processar o mesmo voto duas vezes (o WhatsApp reenvia eventos)
const votosProcessados = new Set();

let clienteConectado = false;
let reconectando = false;

// ==========================================
// UTILITÁRIOS
// ==========================================
function log(...args) {
    console.log(`[${new Date().toLocaleString('pt-BR')}]`, ...args);
}

function dataParaString(dateObj) {
    const d = String(dateObj.getDate()).padStart(2, '0');
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    return `${d}/${m}/${dateObj.getFullYear()}`;
}

function stringParaData(dataStr, horaStr = '00:00') {
    const [d, m, y] = String(dataStr).split('/').map(Number);
    const [hh, mm] = String(horaStr).split(':').map(Number);
    return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0);
}

function dataValida(dataStr) {
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(String(dataStr || ''))) return false;
    const dt = stringParaData(dataStr);
    return !isNaN(dt.getTime());
}

function validarDataInput(texto) {
    const limpo = String(texto).replace(/\D/g, '');
    let d, m, y;
    const anoAtual = new Date().getFullYear();

    if (limpo.length === 4) {
        d = limpo.substring(0, 2); m = limpo.substring(2, 4); y = String(anoAtual);
    } else if (limpo.length === 6) {
        d = limpo.substring(0, 2); m = limpo.substring(2, 4); y = '20' + limpo.substring(4, 6);
    } else if (limpo.length === 8) {
        d = limpo.substring(0, 2); m = limpo.substring(2, 4); y = limpo.substring(4, 8);
    } else {
        return null;
    }

    const dia = parseInt(d), mes = parseInt(m), ano = parseInt(y);
    if (dia < 1 || dia > 31 || mes < 1 || mes > 12) return null;

    const dataInput = new Date(ano, mes - 1, dia);
    if (dataInput.getDate() !== dia || dataInput.getMonth() !== mes - 1) return null;

    const hojeZerado = new Date();
    hojeZerado.setHours(0, 0, 0, 0);
    if (dataInput < hojeZerado) return { erro: 'PASSADO' };

    return {
        string: `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${ano}`,
        diaSemana: dataInput.getDay()
    };
}

function horaFimDoDia(diaSemana) {
    if (diaSemana === 0) return null;      // domingo fechado
    if (diaSemana === 6) return '18:00';   // sábado
    return '19:00';
}

function gerarHorarios(horaInicio, horaFim, intervaloMinutos) {
    const slots = [];
    const [inicioH, inicioM] = horaInicio.split(':').map(Number);
    const [fimH, fimM] = horaFim.split(':').map(Number);

    const tempoAtual = new Date(2000, 0, 1, inicioH, inicioM);
    const tempoFinal = new Date(2000, 0, 1, fimH, fimM);
    if (tempoFinal <= tempoAtual) tempoFinal.setDate(tempoFinal.getDate() + 1);

    while (tempoAtual < tempoFinal) {
        const h = String(tempoAtual.getHours()).padStart(2, '0');
        const m = String(tempoAtual.getMinutes()).padStart(2, '0');
        const hora = `${h}:${m}`;
        const isAlmoco = HORARIOS_ALMOCO.includes(hora);

        slots.push({
            hora,
            status: isAlmoco ? 'ocupado' : 'disponivel',
            cliente: isAlmoco ? 'ALMOÇO' : null,
            servico: isAlmoco ? 'Pausa' : null,
            whatsapp: null
        });

        tempoAtual.setMinutes(tempoAtual.getMinutes() + intervaloMinutos);
    }
    return slots;
}

// Cria a agenda de uma data, se ainda não existir. Retorna os horários da data.
async function garantirAgendaDaData(dataString) {
    if (!dataValida(dataString)) return [];

    const existentes = await prisma.horario.findMany({
        where: { data: dataString },
        orderBy: { hora: 'asc' }
    });
    if (existentes.length > 0) return existentes;

    const hFim = horaFimDoDia(stringParaData(dataString).getDay());
    if (!hFim) return [];

    if (gerandoAgendaLock[dataString]) {
        await new Promise(r => setTimeout(r, 1200));
        return prisma.horario.findMany({ where: { data: dataString }, orderBy: { hora: 'asc' } });
    }

    gerandoAgendaLock[dataString] = true;
    try {
        const novosSlots = gerarHorarios('09:00', hFim, BLOCO_MINUTOS);
        await prisma.horario.createMany({
            data: novosSlots.map(s => ({ ...s, data: dataString })),
            skipDuplicates: true
        });
    } catch (err) {
        log('Erro ao gerar agenda de', dataString, '->', err.message);
    } finally {
        delete gerandoAgendaLock[dataString];
    }

    return prisma.horario.findMany({ where: { data: dataString }, orderBy: { hora: 'asc' } });
}

// Retorna os horários de início possíveis para um serviço que ocupa N blocos
function calcularHorariosValidos(todosHorarios, blocosNecessarios, dataString) {
    const ordenados = [...todosHorarios].sort((a, b) => a.hora.localeCompare(b.hora));
    const validos = [];

    for (let i = 0; i <= ordenados.length - blocosNecessarios; i++) {
        let sequenciaOk = true;
        for (let j = 0; j < blocosNecessarios; j++) {
            const atual = ordenados[i + j];
            if (atual.status !== 'disponivel') { sequenciaOk = false; break; }
            if (j > 0) {
                const anterior = ordenados[i + j - 1];
                const diff = stringParaData(dataString, atual.hora) - stringParaData(dataString, anterior.hora);
                if (diff !== BLOCO_MINUTOS * 60000) { sequenciaOk = false; break; }
            }
        }
        if (sequenciaOk) validos.push(ordenados[i]);
    }

    // Se for hoje, remove horários que já passaram (com 10 min de margem)
    const agora = new Date();
    if (dataString === dataParaString(agora)) {
        const limite = new Date(agora.getTime() + 10 * 60000);
        return validos.filter(h => stringParaData(dataString, h.hora) > limite);
    }
    return validos;
}

async function botEstaAtivo() {
    try {
        const config = await prisma.configuracao.findUnique({ where: { id: 1 } });
        return config ? config.botAtivo : true;
    } catch {
        return true;
    }
}

// ==========================================
// ENVIO DE ENQUETES (OPÇÕES CLICÁVEIS)
// ==========================================
async function enviarEnquete(chatId, pergunta, opcoes, tipo, textoAntes = null, multipla = false) {
    // opcoes: [{ id, label }]
    const opcoesLimitadas = opcoes
        .slice(0, MAX_OPCOES_ENQUETE + 1)
        .map(o => ({ ...o, label: String(o.label).substring(0, MAX_TAMANHO_OPCAO) }));

    if (textoAntes) {
        await client.sendMessage(chatId, textoAntes).catch(() => {});
    }

    const registro = { chatId, tipo, opcoes: opcoesLimitadas, multipla, criadaEm: Date.now() };

    const enviarMenuNumerado = async () => {
        ultimaEnquetePorChat[chatId] = registro;
        const menu = opcoesLimitadas.map((o, i) => `*[ ${i + 1} ]* - ${o.label}`).join('\n');
        const instrucao = multipla
            ? '👉 Digite os números desejados separados por vírgula.\n_Ex: 1,3 para escolher dois serviços._'
            : '👉 Digite o número da opção desejada.';
        await client.sendMessage(chatId, `${pergunta}\n\n${menu}\n\n${instrucao}`).catch(() => {});
    };

    if (!USAR_ENQUETES) {
        await enviarMenuNumerado();
        return false;
    }

    try {
        const poll = new Poll(pergunta, opcoesLimitadas.map(o => o.label), { allowMultipleAnswers: multipla });
        const enviada = await client.sendMessage(chatId, poll);
        const messageId = enviada?.id?._serialized;
        if (messageId) {
            registro.messageId = messageId;
            enquetesPorMensagem[messageId] = registro;
        }
        ultimaEnquetePorChat[chatId] = registro;
        return true;
    } catch (err) {
        // Se a enquete falhar, cai automaticamente para o menu numerado
        log('Falha ao enviar enquete, usando menu numerado:', err.message);
        await enviarMenuNumerado();
        return false;
    }
}

// Converte texto digitado em VÁRIOS ids (ex.: "1,3" ou "1 3")
function resolverEscolhasMultiplas(chatId, texto) {
    const registro = ultimaEnquetePorChat[chatId];
    if (!registro) return [];

    const numeros = String(texto).match(/\d{1,2}/g);
    if (!numeros) return [];

    const ids = [];
    for (const n of numeros) {
        const opcao = registro.opcoes[parseInt(n) - 1];
        if (opcao && !ids.includes(opcao.id)) ids.push(opcao.id);
    }
    return ids;
}

// Converte texto digitado em um id de opção da última enquete do chat
function resolverEscolhaPorTexto(chatId, texto) {
    const registro = ultimaEnquetePorChat[chatId];
    if (!registro) return null;

    const limpo = String(texto).trim().toLowerCase();

    // 1) digitou o número da opção
    if (/^\d{1,2}$/.test(limpo)) {
        const idx = parseInt(limpo) - 1;
        if (registro.opcoes[idx]) return registro.opcoes[idx].id;
    }

    // 2) digitou/copiou o texto exato da opção
    const exato = registro.opcoes.find(o => o.label.toLowerCase() === limpo);
    if (exato) return exato.id;

    // 3) digitou parte reconhecível da opção
    if (limpo.length >= 4) {
        const parcial = registro.opcoes.find(o => o.label.toLowerCase().includes(limpo));
        if (parcial) return parcial.id;
    }

    return null;
}

function limparEnquetesDoChat(chatId) {
    const registro = ultimaEnquetePorChat[chatId];
    if (registro?.messageId) delete enquetesPorMensagem[registro.messageId];
    delete ultimaEnquetePorChat[chatId];
}

function encerrarAtendimento(chatId) {
    delete estadosUsuarios[chatId];
    delete dadosTemporarios[chatId];
    limparEnquetesDoChat(chatId);
}

// ==========================================
// MENUS DO FLUXO
// ==========================================
async function enviarMenuServicos(chatId, nomeCliente) {
    const servicos = await prisma.servico.findMany({ orderBy: { id: 'asc' } });
    if (servicos.length === 0) {
        return client.sendMessage(chatId, '⚠️ Estamos atualizando nossa lista de serviços. Tente novamente em alguns instantes.');
    }

    const opcoes = servicos.slice(0, MAX_OPCOES_ENQUETE - 1).map(s => ({
        id: `servico_${s.id}`,
        label: `${s.nome} - R$ ${s.preco}`
    }));
    if (USAR_ENQUETES) opcoes.push({ id: 'servico_confirmar', label: '✅ Pronto, confirmar escolha' });
    opcoes.push({ id: 'cancelar_agendamento', label: '❌ Cancelar um agendamento que já fiz' });
    opcoes.push({ id: 'cancelar', label: '🚪 Sair do atendimento' });

    estadosUsuarios[chatId] = 'ESCOLHENDO_SERVICO';
    dadosTemporarios[chatId] = { servicosEscolhidos: [] };

    const saudacao =
        `👋 Olá, ${nomeCliente}! Bem-vindo(a) à *${NOME_BARBEARIA}*.\n\n` +
        `É um prazer ter você aqui. Você pode escolher *mais de um serviço* ` +
        `(cabelo, barba, pezinho...) na mesma visita.`;

    await enviarEnquete(chatId, '✂️ *Quais serviços você deseja?*', opcoes, 'SERVICO', saudacao, true);
}

async function enviarMenuDatas(chatId) {
    const opcoes = [];
    const hoje = new Date();
    const nomesDia = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

    for (let i = 0; i < 12 && opcoes.length < 6; i++) {
        const dia = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + i);
        if (dia.getDay() === 0) continue; // fechado aos domingos

        const dataStr = dataParaString(dia);
        let rotulo;
        if (i === 0) rotulo = `Hoje (${dataStr.substring(0, 5)})`;
        else if (i === 1) rotulo = `Amanhã (${dataStr.substring(0, 5)})`;
        else rotulo = `${nomesDia[dia.getDay()]} (${dataStr.substring(0, 5)})`;

        opcoes.push({ id: `data_${dataStr}`, label: rotulo });
    }

    opcoes.push({ id: 'data_outra', label: 'Outra data (vou digitar)' });
    opcoes.push({ id: 'cancelar', label: 'Cancelar atendimento' });

    estadosUsuarios[chatId] = 'ESCOLHENDO_DATA';
    await enviarEnquete(chatId, '📅 Para qual dia você quer agendar?', opcoes, 'DATA');
}

async function enviarMenuHorarios(chatId, dataString, pagina = 0) {
    const dados = dadosTemporarios[chatId];

    // Sessão perdida (ex.: bot reiniciou no meio do atendimento)
    if (!dados || !dados.blocosNecessarios) {
        encerrarAtendimento(chatId);
        await client.sendMessage(chatId, 'Sua sessão expirou. Vamos começar de novo, tudo bem?');
        return enviarMenuServicos(chatId, 'Cliente');
    }

    const todosHorarios = await garantirAgendaDaData(dataString);

    if (todosHorarios.length === 0) {
        await client.sendMessage(chatId, `Não temos expediente em ${dataString}. Escolha outra data, por favor.`);
        return enviarMenuDatas(chatId);
    }

    const validos = calcularHorariosValidos(todosHorarios, dados.blocosNecessarios, dataString);

    if (validos.length === 0) {
        dados.dataLotada = dataString;
        estadosUsuarios[chatId] = 'FILA_ESPERA';
        const texto = `😕 A agenda do dia *${dataString}* já está cheia para o tempo necessário (${dados.tempoTotal} min).`;
        return enviarEnquete(chatId, 'Quer entrar na fila de espera desse dia?', [
            { id: 'fila_sim', label: 'Sim, me avise se abrir vaga' },
            { id: 'fila_nao', label: 'Não, quero escolher outra data' },
            { id: 'cancelar', label: 'Cancelar atendimento' }
        ], 'FILA', texto);
    }

    const porPagina = MAX_OPCOES_ENQUETE - 1;
    const inicio = pagina * porPagina;
    const fatia = validos.slice(inicio, inicio + porPagina);

    if (fatia.length === 0) return enviarMenuHorarios(chatId, dataString, 0);

    const opcoes = fatia.map(h => ({ id: `hora_${h.id}`, label: h.hora }));
    if (validos.length > inicio + porPagina) {
        opcoes.push({ id: `hora_mais_${pagina + 1}`, label: 'Ver mais horários' });
    } else if (pagina > 0) {
        opcoes.push({ id: 'hora_mais_0', label: 'Voltar ao início da lista' });
    }
    opcoes.push({ id: 'cancelar', label: 'Cancelar atendimento' });

    dados.paginaHorarios = pagina;
    dados.dataEscolhida = dataString;
    estadosUsuarios[chatId] = 'ESCOLHENDO_HORARIO';

    const texto = pagina === 0 ? `🕒 Horários livres para *${dataString}*:` : null;
    await enviarEnquete(chatId, 'Toque no horário desejado', opcoes, 'HORARIO', texto);
}

// ==========================================
// PROCESSAMENTO DE ESCOLHAS (enquete ou texto)
// ==========================================
async function processarEscolha(chatId, escolhaId, contato) {
    const estado = estadosUsuarios[chatId];

    if (escolhaId === 'cancelar') {
        encerrarAtendimento(chatId);
        return client.sendMessage(chatId, '👋 Atendimento encerrado. Quando quiser, é só mandar um "Oi". Estamos à disposição!');
    }

    if (escolhaId === 'cancelar_agendamento') {
        return cancelarAgendamentoDoCliente(chatId, contato);
    }

    // ---- DATA ----
    if (estado === 'ESCOLHENDO_DATA' && escolhaId.startsWith('data_')) {
        if (escolhaId === 'data_outra') {
            estadosUsuarios[chatId] = 'DIGITANDO_DATA';
            return client.sendMessage(chatId, '📅 Sem problema! Digite a data desejada no formato dia/mês.\n_Exemplo: 28/08_');
        }
        return enviarMenuHorarios(chatId, escolhaId.replace('data_', ''), 0);
    }

    // ---- FILA DE ESPERA ----
    if (estado === 'FILA_ESPERA') {
        if (escolhaId === 'fila_sim') {
            const dataFila = dadosTemporarios[chatId]?.dataLotada;
            if (dataFila) {
                try {
                    await prisma.filaEspera.upsert({
                        where: { data_chatId: { data: dataFila, chatId } },
                        update: {},
                        create: { data: dataFila, chatId, cliente: contato?.pushname || null }
                    });
                } catch (err) { log('Erro ao salvar fila:', err.message); }
            }
            encerrarAtendimento(chatId);
            return client.sendMessage(chatId, `✅ Pronto! Você entrou na fila de espera do dia *${dataFila}*.\n\nSe abrir vaga, avisamos por aqui na hora.`);
        }
        if (escolhaId === 'fila_nao') return enviarMenuDatas(chatId);
    }

    // ---- HORÁRIO ----
    if (estado === 'ESCOLHENDO_HORARIO') {
        if (escolhaId.startsWith('hora_mais_')) {
            const pagina = parseInt(escolhaId.replace('hora_mais_', ''));
            return enviarMenuHorarios(chatId, dadosTemporarios[chatId]?.dataEscolhida, pagina);
        }

        if (escolhaId.startsWith('hora_')) {
            const horarioId = parseInt(escolhaId.replace('hora_', ''));
            const horario = await prisma.horario.findUnique({ where: { id: horarioId } });

            if (!horario || horario.status !== 'disponivel') {
                await client.sendMessage(chatId, '⚠️ Esse horário acabou de ser reservado. Escolha outro, por favor.');
                return enviarMenuHorarios(chatId, dadosTemporarios[chatId]?.dataEscolhida, 0);
            }

            dadosTemporarios[chatId].horarioId = horario.id;
            dadosTemporarios[chatId].horarioHora = horario.hora;

            const nomePerfil = contato?.pushname?.trim();
            estadosUsuarios[chatId] = 'DIGITANDO_NOME';

            const aviso = `✅ Horário das *${horario.hora}* do dia *${dadosTemporarios[chatId].dataEscolhida}* pré-reservado para você.`;

            if (nomePerfil && nomePerfil.length >= 2) {
                return enviarEnquete(chatId, '👤 Confirmamos em qual nome?', [
                    { id: 'nome_perfil', label: `Usar o nome ${nomePerfil}` },
                    { id: 'nome_outro', label: 'Digitar outro nome' },
                    { id: 'cancelar', label: 'Cancelar atendimento' }
                ], 'NOME', aviso);
            }

            return client.sendMessage(chatId, `${aviso}\n\n👤 Para finalizar, digite seu *primeiro nome*:`);
        }
    }

    // ---- NOME ----
    if (estado === 'DIGITANDO_NOME') {
        if (escolhaId === 'nome_perfil') {
            return confirmarAgendamento(chatId, contato?.pushname?.trim() || 'Cliente', contato);
        }
        if (escolhaId === 'nome_outro') {
            estadosUsuarios[chatId] = 'DIGITANDO_NOME_TEXTO';
            limparEnquetesDoChat(chatId);
            return client.sendMessage(chatId, '👤 Certo! Digite o *primeiro nome* para o agendamento:');
        }
    }

    // ---- AVALIAÇÃO ----
    if (estado === 'AGUARDANDO_AVALIACAO' && escolhaId.startsWith('nota_')) {
        return registrarAvaliacao(chatId, parseInt(escolhaId.replace('nota_', '')), contato);
    }

    return null;
}

// Recebe TODOS os serviços marcados na enquete de uma vez
async function processarServicosSelecionados(chatId, idsEscolhidos, contato) {
    const ids = idsEscolhidos
        .filter(id => id.startsWith('servico_') && id !== 'servico_confirmar')
        .map(id => parseInt(id.replace('servico_', '')))
        .filter(n => !isNaN(n));

    if (ids.length === 0) {
        return client.sendMessage(chatId,
            '⚠️ Você ainda não marcou nenhum serviço.\n\nMarque os serviços desejados na enquete acima e depois toque em *"Pronto, confirmar escolha"*.');
    }

    const servicos = await prisma.servico.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
    if (servicos.length === 0) {
        return client.sendMessage(chatId, 'Não encontramos esses serviços. Envie "Oi" para recomeçar.');
    }

    if (!dadosTemporarios[chatId]) dadosTemporarios[chatId] = {};
    dadosTemporarios[chatId].servicosEscolhidos = servicos;

    const nomes = servicos.map(s => s.nome).join(' + ');
    const tempo = servicos.reduce((acc, s) => acc + (s.duracao || 30), 0);
    const total = servicos.reduce((acc, s) => {
        const valor = parseFloat(String(s.preco).replace(/[^\d,.-]/g, '').replace(',', '.'));
        return acc + (isNaN(valor) ? 0 : valor);
    }, 0);

    await client.sendMessage(chatId,
        `✅ *Serviços selecionados:*\n${servicos.map(s => `• ${s.nome} - R$ ${s.preco}`).join('\n')}\n\n` +
        `💰 *Total:* R$ ${total.toFixed(2).replace('.', ',')}\n` +
        `⏳ *Duração:* aprox. ${tempo} min`);

    return finalizarSelecaoServicos(chatId);
}

function finalizarSelecaoServicos(chatId) {
    const dados = dadosTemporarios[chatId];
    if (!dados?.servicosEscolhidos?.length) return enviarMenuServicos(chatId, 'Cliente');

    const tempoTotal = dados.servicosEscolhidos.reduce((acc, s) => acc + (s.duracao || 30), 0);

    dados.servicoNome = dados.servicosEscolhidos.map(s => s.nome).join(' + ');
    dados.tempoTotal = tempoTotal;
    dados.blocosNecessarios = Math.max(1, Math.ceil(tempoTotal / BLOCO_MINUTOS));

    return enviarMenuDatas(chatId);
}

// ==========================================
// CONFIRMAÇÃO DO AGENDAMENTO
// ==========================================
async function confirmarAgendamento(chatId, nomeCliente, contato) {
    const dados = dadosTemporarios[chatId];
    if (!dados || !dados.horarioId || !dados.dataEscolhida) {
        encerrarAtendimento(chatId);
        return client.sendMessage(chatId, 'Sua sessão expirou. Envie "Oi" para recomeçar o agendamento.');
    }

    const numeroReal = contato?.number || chatId.split('@')[0];
    const dataString = dados.dataEscolhida;

    // Busca os blocos consecutivos a partir do horário escolhido
    const todosDoDia = await prisma.horario.findMany({
        where: { data: dataString },
        orderBy: { hora: 'asc' }
    });

    const idxInicio = todosDoDia.findIndex(h => h.id === dados.horarioId);
    if (idxInicio === -1) {
        encerrarAtendimento(chatId);
        return client.sendMessage(chatId, 'Não localizamos esse horário. Envie "Oi" para recomeçar.');
    }

    const slotsParaOcupar = todosDoDia.slice(idxInicio, idxInicio + dados.blocosNecessarios);
    const todosLivres =
        slotsParaOcupar.length === dados.blocosNecessarios &&
        slotsParaOcupar.every(s => s.status === 'disponivel');

    if (!todosLivres) {
        estadosUsuarios[chatId] = 'ESCOLHENDO_HORARIO';
        await client.sendMessage(chatId, '⚠️ Esse horário acabou de ser reservado por outro cliente. Escolha outro, por favor.');
        return enviarMenuHorarios(chatId, dataString, 0);
    }

    const grupoId = crypto.randomUUID();

    // Reserva condicional: só ocupa se ainda estiver disponível (evita reserva dupla)
    const resultado = await prisma.horario.updateMany({
        where: { id: { in: slotsParaOcupar.map(s => s.id) }, status: 'disponivel' },
        data: {
            status: 'ocupado',
            cliente: nomeCliente,
            servico: dados.servicoNome,
            whatsapp: numeroReal,
            chatId: chatId,
            grupoId: grupoId,
            lembreteEnviado: false,
            feedbackEnviado: false
        }
    });

    if (resultado.count !== slotsParaOcupar.length) {
        // Desfaz a reserva parcial e pede outro horário
        await prisma.horario.updateMany({
            where: { grupoId },
            data: { status: 'disponivel', cliente: null, servico: null, whatsapp: null, chatId: null, grupoId: null }
        });
        estadosUsuarios[chatId] = 'ESCOLHENDO_HORARIO';
        await client.sendMessage(chatId, '⚠️ Esse horário acabou de ser reservado. Escolha outro, por favor.');
        return enviarMenuHorarios(chatId, dataString, 0);
    }

    const msgCliente =
        `🎉 *Agendamento confirmado!*\n\n` +
        `👤 *Cliente:* ${nomeCliente}\n` +
        `✂️ *Serviço:* ${dados.servicoNome}\n` +
        `📅 *Data:* ${dataString}\n` +
        `🕒 *Horário:* ${dados.horarioHora}\n\n` +
        `Obrigado pela preferência! Se precisar cancelar, é só enviar *cancelar agendamento*.`;

    const msgBarbeiro =
        `🚨 *NOVO AGENDAMENTO*\n\n` +
        `👤 Cliente: *${nomeCliente}*\n` +
        `📱 Contato: ${numeroReal}\n` +
        `✂️ Serviço: ${dados.servicoNome}\n` +
        `📅 Data: ${dataString}\n` +
        `🕒 Horário: *${dados.horarioHora}*`;

    await client.sendMessage(chatId, msgCliente);
    await notificarBarbeiro(msgBarbeiro);

    log('Agendamento confirmado:', nomeCliente, dataString, dados.horarioHora);
    encerrarAtendimento(chatId);
}

async function notificarBarbeiro(mensagem) {
    try {
        const idVerificado = await client.getNumberId(NUMERO_DO_BARBEIRO);
        if (idVerificado) await client.sendMessage(idVerificado._serialized, mensagem);
    } catch (err) {
        log('Erro ao notificar o barbeiro:', err.message);
    }
}

async function registrarAvaliacao(chatId, nota, contato) {
    encerrarAtendimento(chatId);

    try {
        await prisma.avaliacao.create({
            data: {
                cliente: contato?.pushname || null,
                whatsapp: contato?.number || chatId.split('@')[0],
                nota
            }
        });
    } catch (err) { log('Erro ao salvar avaliação:', err.message); }

    if (nota >= 4) {
        return client.sendMessage(chatId, '⭐ Muito obrigado pela avaliação! Ficamos felizes que tenha gostado. Até a próxima!');
    }

    await notificarBarbeiro(`⚠️ *ALERTA DE QUALIDADE*\n\nO cliente ${contato?.pushname || chatId} avaliou o atendimento com nota *${nota}*.`);
    return client.sendMessage(chatId, 'Obrigado pelo feedback sincero! Vamos trabalhar para melhorar e te surpreender na próxima visita. 🙌');
}

// ==========================================
// FILA DE ESPERA
// ==========================================
async function avisarFila(dataVaga) {
    if (!dataVaga) return;
    try {
        const fila = await prisma.filaEspera.findMany({ where: { data: dataVaga } });
        if (fila.length === 0) return;

        const msg = `🚨 *Vaga liberada!*\n\nAbriu um horário para o dia *${dataVaga}*.\n\nSe ainda tiver interesse, envie um "Oi" aqui para garantir a vaga.`;
        for (const item of fila) {
            await client.sendMessage(item.chatId, msg).catch(() => {});
        }
        await prisma.filaEspera.deleteMany({ where: { data: dataVaga } });
        log('Fila de espera avisada:', dataVaga, `(${fila.length} pessoas)`);
    } catch (err) {
        log('Erro ao avisar a fila:', err.message);
    }
}

// ==========================================
// ROTINAS AUTOMÁTICAS
// ==========================================

// Lembrete ~15 min antes. Usa JANELA de tempo (não match exato de minuto),
// deduplica por grupoId e persiste o envio no banco.
async function verificarLembretes() {
    if (!clienteConectado) return;

    const agora = new Date();
    const datasRelevantes = [
        dataParaString(agora),
        dataParaString(new Date(agora.getTime() + 24 * 3600000))
    ];

    try {
        const candidatos = await prisma.horario.findMany({
            where: {
                data: { in: datasRelevantes },
                status: 'ocupado',
                lembreteEnviado: false,
                grupoId: { not: null }
            },
            orderBy: { hora: 'asc' }
        });

        // Mantém apenas o primeiro bloco de cada agendamento
        const primeiroPorGrupo = new Map();
        for (const slot of candidatos) {
            if (!primeiroPorGrupo.has(slot.grupoId)) primeiroPorGrupo.set(slot.grupoId, slot);
        }

        for (const slot of primeiroPorGrupo.values()) {
            const destino = slot.chatId || (slot.whatsapp ? `${slot.whatsapp}@c.us` : null);
            if (!destino || slot.whatsapp === 'Painel Web') continue;

            const minutosAte = (stringParaData(slot.data, slot.hora) - agora) / 60000;

            // Janela de 12 a 18 min: tolera atraso do timer sem perder o lembrete
            if (minutosAte < 12 || minutosAte > 18) continue;

            const msg =
                `🔔 *Lembrete de agendamento - ${NOME_BARBEARIA}*\n\n` +
                `Olá, ${slot.cliente}! Seu horário de *${slot.servico}* é hoje às *${slot.hora}*.\n` +
                `Estamos te aguardando! ✂️`;

            try {
                await client.sendMessage(destino, msg);
                await prisma.horario.updateMany({
                    where: { grupoId: slot.grupoId },
                    data: { lembreteEnviado: true }
                });
                log('Lembrete enviado:', slot.cliente, slot.hora);
            } catch (err) {
                log('Falha ao enviar lembrete:', err.message);
            }
        }
    } catch (err) {
        log('Erro na rotina de lembretes:', err.message);
    }
}

// Feedback ~2h depois do FIM do atendimento (a versão antiga usava o início e repetia por bloco)
async function verificarFeedbacks() {
    if (!clienteConectado) return;

    const agora = new Date();
    if (agora.getHours() < 8 || agora.getHours() >= 21) return; // não incomoda de madrugada

    const datasRelevantes = [
        dataParaString(agora),
        dataParaString(new Date(agora.getTime() - 24 * 3600000))
    ];

    try {
        const candidatos = await prisma.horario.findMany({
            where: {
                data: { in: datasRelevantes },
                status: 'ocupado',
                feedbackEnviado: false,
                grupoId: { not: null }
            },
            orderBy: { hora: 'desc' }
        });

        // Último bloco de cada agendamento = fim do atendimento
        const ultimoPorGrupo = new Map();
        for (const slot of candidatos) {
            if (!ultimoPorGrupo.has(slot.grupoId)) ultimoPorGrupo.set(slot.grupoId, slot);
        }

        for (const slot of ultimoPorGrupo.values()) {
            const destino = slot.chatId || (slot.whatsapp ? `${slot.whatsapp}@c.us` : null);
            if (!destino || slot.whatsapp === 'Painel Web') continue;

            const fim = new Date(stringParaData(slot.data, slot.hora).getTime() + BLOCO_MINUTOS * 60000);
            const minutosDesde = (agora - fim) / 60000;

            // Janela de 2h a 2h06 depois do fim
            if (minutosDesde < 120 || minutosDesde > 126) continue;

            try {
                // Marca antes de enviar para nunca duplicar
                await prisma.horario.updateMany({
                    where: { grupoId: slot.grupoId },
                    data: { feedbackEnviado: true }
                });

                estadosUsuarios[destino] = 'AGUARDANDO_AVALIACAO';
                await enviarEnquete(destino, '⭐ Como você avalia nosso atendimento?', [
                    { id: 'nota_5', label: '5 - Excelente' },
                    { id: 'nota_4', label: '4 - Muito bom' },
                    { id: 'nota_3', label: '3 - Regular' },
                    { id: 'nota_2', label: '2 - Ruim' },
                    { id: 'nota_1', label: '1 - Péssimo' }
                ], 'AVALIACAO',
                    `Olá, ${slot.cliente}! Esperamos que tenha gostado do seu *${slot.servico}* de hoje.\n\nSua opinião é muito importante para nós.`);

                log('Feedback solicitado:', slot.cliente);
            } catch (err) {
                log('Falha ao enviar feedback:', err.message);
            }
        }
    } catch (err) {
        log('Erro na rotina de feedback:', err.message);
    }
}

let resumoEnviadoEm = null;
async function verificarResumoDiario() {
    if (!clienteConectado) return;

    const agora = new Date();
    const hojeStr = dataParaString(agora);
    const minutosDoDia = agora.getHours() * 60 + agora.getMinutes();

    // Envia entre 08:30 e 08:40, uma única vez por dia
    if (minutosDoDia < 510 || minutosDoDia > 520) return;
    if (resumoEnviadoEm === hojeStr) return;
    resumoEnviadoEm = hojeStr;

    try {
        const reservas = await prisma.horario.findMany({
            where: { data: hojeStr, status: 'ocupado', grupoId: { not: null } },
            orderBy: { hora: 'asc' }
        });

        const porGrupo = new Map();
        for (const r of reservas) if (!porGrupo.has(r.grupoId)) porGrupo.set(r.grupoId, r);

        let resumo = `📅 *Agenda de hoje (${hojeStr})*\n\n`;
        if (porGrupo.size === 0) resumo += 'Nenhum agendamento por enquanto.';
        else for (const r of porGrupo.values()) resumo += `🕒 ${r.hora} - ${r.cliente} (${r.servico})\n`;

        await notificarBarbeiro(resumo);
        log('Resumo diário enviado.');
    } catch (err) {
        log('Erro no resumo diário:', err.message);
    }
}

async function limpezaDiaria() {
    try {
        const antiga = new Date();
        antiga.setDate(antiga.getDate() - 2);
        const limite = dataParaString(antiga);

        await prisma.horario.deleteMany({ where: { data: limite } });
        await prisma.filaEspera.deleteMany({ where: { data: limite } });
        await garantirAgendaDaData(dataParaString(new Date()));

        log('Limpeza diária concluída.');
    } catch (err) {
        log('Erro na limpeza diária:', err.message);
    }
}

let ultimaLimpeza = null;
let rotinasAtivas = false;
function iniciarRotinas() {
    if (rotinasAtivas) return;
    rotinasAtivas = true;

    setInterval(async () => {
        try {
            await verificarResumoDiario();
            await verificarLembretes();
            await verificarFeedbacks();

            const hojeStr = dataParaString(new Date());
            if (ultimaLimpeza !== hojeStr && new Date().getHours() >= 1) {
                ultimaLimpeza = hojeStr;
                await limpezaDiaria();
            }
        } catch (err) {
            log('Erro no ciclo de rotinas:', err.message);
        }
    }, 60 * 1000);

    log('Rotinas automáticas iniciadas (lembretes, feedback, resumo e limpeza).');
}

// ==========================================
// ROTAS DA API
// ==========================================
app.get('/health', async (req, res) => {
    let estadoWpp = 'DESCONHECIDO';
    try { estadoWpp = (await client.getState()) || 'SEM_ESTADO'; } catch { estadoWpp = 'INDISPONIVEL'; }

    const saudavel = clienteConectado && estadoWpp === 'CONNECTED';
    res.status(saudavel ? 200 : 503).json({
        ok: saudavel,
        whatsapp: estadoWpp,
        uptimeSegundos: Math.round(process.uptime()),
        memoriaMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
    });
});

app.get('/api/servicos', async (req, res) => {
    try {
        res.json(await prisma.servico.findMany({ orderBy: { id: 'asc' } }));
    } catch { res.status(500).json({ erro: 'Erro ao buscar serviços' }); }
});

app.post('/api/servicos', async (req, res) => {
    try {
        const { nome, preco, duracao } = req.body;
        const novo = await prisma.servico.create({
            data: { nome, preco, duracao: parseInt(duracao) || 30 }
        });
        res.status(201).json(novo);
    } catch { res.status(500).json({ erro: 'Erro ao criar serviço' }); }
});

app.delete('/api/servicos/:id', async (req, res) => {
    try {
        await prisma.servico.delete({ where: { id: parseInt(req.params.id) } });
        res.json({ mensagem: 'Serviço removido' });
    } catch { res.status(500).json({ erro: 'Erro ao remover serviço' }); }
});

app.get('/api/horarios', async (req, res) => {
    try {
        const { data } = req.query;
        if (!data) return res.json(await prisma.horario.findMany({ orderBy: { id: 'asc' } }));
        res.json(await garantirAgendaDaData(data));
    } catch { res.status(500).json({ erro: 'Erro ao buscar agenda' }); }
});

app.put('/api/horarios/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { status, cliente, servico } = req.body;
        const liberando = status === 'disponivel';

        const antigo = await prisma.horario.findUnique({ where: { id } });
        const atualizado = await prisma.horario.update({
            where: { id },
            data: {
                status,
                cliente: liberando ? null : (cliente || 'Presencial/Balcão'),
                servico: liberando ? null : (servico || 'Não especificado'),
                whatsapp: liberando ? null : 'Painel Web',
                chatId: liberando ? null : undefined,
                grupoId: liberando ? null : undefined,
                lembreteEnviado: liberando ? false : undefined,
                feedbackEnviado: liberando ? false : undefined
            }
        });

        if (liberando && antigo?.status === 'ocupado') avisarFila(atualizado.data);
        res.json(atualizado);
    } catch { res.status(500).json({ erro: 'Erro ao atualizar horário' }); }
});

app.get('/api/avaliacoes', async (req, res) => {
    try {
        const avaliacoes = await prisma.avaliacao.findMany({ orderBy: { criadoEm: 'desc' }, take: 100 });
        const media = avaliacoes.length
            ? (avaliacoes.reduce((a, b) => a + b.nota, 0) / avaliacoes.length).toFixed(2)
            : null;
        res.json({ media, total: avaliacoes.length, avaliacoes });
    } catch { res.status(500).json({ erro: 'Erro ao buscar avaliações' }); }
});

app.post('/api/bot/status', async (req, res) => {
    try {
        const { ativo } = req.body;
        await prisma.configuracao.upsert({
            where: { id: 1 },
            update: { botAtivo: ativo },
            create: { id: 1, botAtivo: ativo }
        });
        log('Bot', ativo ? 'ATIVADO' : 'DESATIVADO', 'pelo painel.');
        res.json({ mensagem: 'Status alterado' });
    } catch { res.status(500).json({ erro: 'Erro ao mudar status' }); }
});

app.get('/api/bot/status', async (req, res) => {
    res.json({ ativo: await botEstaAtivo(), conectado: clienteConectado });
});

// ==========================================
// CLIENTE DO WHATSAPP
// ==========================================
const client = new Client({
    authStrategy: new LocalAuth(),
    webVersionCache: { type: 'none' },
    takeoverOnConflict: true,
    takeoverTimeoutMs: 10000,
    puppeteer: {
        headless: true,
        executablePath: CHROME_PATH,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-extensions',
            '--disable-gpu',
            '--no-first-run',
            '--mute-audio'
        ]
    }
});

client.on('loading_screen', (percent, message) => {
    log(`Carregando WhatsApp: ${percent}% | ${message}`);
});

client.on('qr', (qr) => {
    log('QR Code gerado. Escaneie com o WhatsApp da barbearia.');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => log('Autenticado com sucesso.'));

client.on('auth_failure', (msg) => {
    log('FALHA DE AUTENTICAÇÃO:', msg);
    log('A sessão provavelmente expirou. O processo vai reiniciar para mostrar o QR Code.');
    process.exit(1);
});

client.on('change_state', (state) => log('Estado do WhatsApp:', state));

client.on('ready', async () => {
    clienteConectado = true;
    reconectando = false;
    log(`Bot conectado! ${NOME_BARBEARIA}`);

    await garantirAgendaDaData(dataParaString(new Date()));
    iniciarRotinas();
    iniciarWatchdog();
});

client.on('disconnected', async (reason) => {
    clienteConectado = false;
    log('DESCONECTADO:', reason);
    await reconectar();
});

// ==========================================
// RECONEXÃO E WATCHDOG
// ==========================================
async function reconectar() {
    if (reconectando) return;
    reconectando = true;

    log('Tentando reconectar em 10 segundos...');
    await new Promise(r => setTimeout(r, 10000));

    try {
        await client.destroy().catch(() => {});
        await client.initialize();
        log('Reconexão iniciada.');
        reconectando = false;
    } catch (err) {
        log('Falha ao reconectar:', err.message, '- reiniciando o processo.');
        process.exit(1); // PM2 sobe de novo com ambiente limpo
    }
}

let watchdogAtivo = false;
function iniciarWatchdog() {
    if (watchdogAtivo) return;
    watchdogAtivo = true;

    setInterval(async () => {
        if (reconectando) return;
        try {
            const estado = await client.getState();
            if (estado !== 'CONNECTED') {
                log('Watchdog detectou estado anormal:', estado);
                clienteConectado = false;
                await reconectar();
            } else if (!clienteConectado) {
                clienteConectado = true;
                log('Watchdog: conexão restabelecida.');
            }
        } catch (err) {
            log('Watchdog não conseguiu ler o estado:', err.message);
            clienteConectado = false;
            await reconectar();
        }
    }, 5 * 60 * 1000);

    log('Watchdog de conexão ativo (checagem a cada 5 min).');
}

// Limpa enquetes antigas da memória (evita crescimento infinito em execução longa)
setInterval(() => {
    const limite = Date.now() - 6 * 3600000;
    for (const [id, reg] of Object.entries(enquetesPorMensagem)) {
        if (reg.criadaEm < limite) delete enquetesPorMensagem[id];
    }
    for (const [chatId, reg] of Object.entries(ultimaEnquetePorChat)) {
        if (reg.criadaEm < limite) delete ultimaEnquetePorChat[chatId];
    }
    if (votosProcessados.size > 5000) votosProcessados.clear();
}, 60 * 60 * 1000);

// ==========================================
// VOTO NA ENQUETE (OPÇÃO CLICADA)
// ==========================================
client.on('vote_update', async (vote) => {
    try {
        const selecionadas = vote?.selectedOptions || [];
        if (selecionadas.length === 0) return; // o cliente desmarcou a opção

        const messageId = vote?.parentMessage?.id?._serialized;
        const registro = messageId ? enquetesPorMensagem[messageId] : null;
        const chatId = registro?.chatId || vote?.parentMessage?.to;
        if (!chatId) return;

        const labels = selecionadas.map(s => s.name);
        const chaveVoto = `${messageId}_${vote.voter}_${[...labels].sort().join('|')}`;
        if (votosProcessados.has(chaveVoto)) return;
        votosProcessados.add(chaveVoto);

        if (!(await botEstaAtivo())) return;

        const registroAtivo = registro || ultimaEnquetePorChat[chatId];
        const opcoes = registroAtivo?.opcoes || [];
        const escolhidas = labels.map(l => opcoes.find(o => o.label === l)).filter(Boolean);
        if (escolhidas.length === 0) return;

        let contato = null;
        try { contato = await client.getContactById(chatId); } catch { /* segue sem contato */ }

        if (!numeroPermitido(chatId, contato)) {
            log('Voto ignorado (número fora da lista de teste):', chatId);
            return;
        }

        log('Voto recebido de', chatId, '->', labels.join(', '));

        // Enquete de múltipla escolha: só age quando o cliente toca em "Pronto, confirmar"
        if (registroAtivo?.multipla) {
            if (escolhidas.some(o => o.id === 'cancelar')) {
                return processarEscolha(chatId, 'cancelar', contato);
            }
            if (!escolhidas.some(o => o.id === 'servico_confirmar')) return; // ainda escolhendo
            return processarServicosSelecionados(chatId, escolhidas.map(o => o.id), contato);
        }

        await processarEscolha(chatId, escolhidas[0].id, contato);
    } catch (err) {
        log('Erro ao processar voto:', err.message);
    }
});

// ==========================================
// MENSAGEM DE TEXTO (FALLBACK)
// ==========================================
client.on('message', async (msg) => {
    try {
        const chatId = msg.from;

        // Filtros de ruído e de mensagens de sistema
        const tiposSistema = ['e2e_notification', 'protocol', 'call_log', 'gp2', 'notification_template', 'poll_creation', 'vote'];
        if (tiposSistema.includes(msg.type)) return;
        if (msg.fromMe) return;
        if (chatId.includes('@newsletter') || chatId.endsWith('@g.us') || chatId === 'status@broadcast') return;
        if (chatId === NUMERO_DO_BARBEIRO + '@c.us') return;
        if (numerosBloqueados.includes(chatId)) return;

        if (!(await botEstaAtivo())) return;

        if (msg.hasMedia || msg.type === 'audio' || msg.type === 'ptt') {
            return msg.reply('🤖 Sou o assistente virtual da barbearia e ainda não consigo ouvir áudios nem ver imagens. Me envie sua mensagem em texto, por favor.');
        }

        const textoOriginal = (msg.body || '').trim();
        const texto = textoOriginal.toLowerCase();
        if (!texto || texto.startsWith('!')) return;

        const contato = await msg.getContact().catch(() => null);
        const nomeCliente = contato?.pushname || 'Cliente';

        // Modo de teste: responde apenas aos números liberados
        if (!numeroPermitido(chatId, contato)) {
            log('Mensagem ignorada. Identificadores vistos:', identificadoresDoContato(chatId, contato).join(' | '),
                '-> para liberar, adicione um deles em NUMEROS_PERMITIDOS.');
            return;
        }

        log('Mensagem de', chatId, '->', textoOriginal);

        // Cancelar o agendamento já existente (aceita várias formas de escrever)
        const pedidoDeCancelamento = [
            'cancelar agendamento', 'cancelar meu agendamento', 'cancelar o agendamento',
            'desmarcar', 'desmarcar agendamento', 'desmarcar horario', 'desmarcar horário',
            'cancelar horario', 'cancelar horário', 'cancelar meu horario', 'cancelar meu horário'
        ];
        if (pedidoDeCancelamento.includes(texto)) {
            return cancelarAgendamentoDoCliente(chatId, contato);
        }

        // Sair do atendimento a qualquer momento
        if (texto === 'cancelar' || texto === 'sair') {
            encerrarAtendimento(chatId);
            return msg.reply('❌ Atendimento cancelado. Quando quiser, é só mandar um "Oi".');
        }

        const estado = estadosUsuarios[chatId];

        // Estados que esperam texto livre
        if (estado === 'DIGITANDO_DATA') {
            const info = validarDataInput(texto);
            if (!info) return msg.reply('❌ Formato inválido. Digite a data como dia/mês.\n_Exemplo: 28/08_');
            if (info.erro === 'PASSADO') return msg.reply('⏰ Essa data já passou. Escolha uma data a partir de hoje.');
            if (info.diaSemana === 0) return msg.reply('🗓️ Não abrimos aos domingos. Escolha outra data, por favor.');
            return enviarMenuHorarios(chatId, info.string, 0);
        }

        if (estado === 'DIGITANDO_NOME_TEXTO') {
            const nome = textoOriginal.split(/\s+/)[0].substring(0, 40);
            if (nome.length < 2) return msg.reply('Nome muito curto. Digite seu primeiro nome, por favor.');
            return confirmarAgendamento(chatId, nome, contato);
        }

        if (estado === 'DIGITANDO_NOME') {
            // Pode ter clicado na enquete de nome ou digitado o nome direto
            const escolhaNome = resolverEscolhaPorTexto(chatId, texto);
            if (escolhaNome) return processarEscolha(chatId, escolhaNome, contato);

            const nome = textoOriginal.split(/\s+/)[0].substring(0, 40);
            if (nome.length < 2) return msg.reply('Nome muito curto. Digite seu primeiro nome, por favor.');
            return confirmarAgendamento(chatId, nome, contato);
        }

        // Escolha de serviços: aceita vários números de uma vez ("1,3" ou "1 3")
        if (estado === 'ESCOLHENDO_SERVICO') {
            const ids = resolverEscolhasMultiplas(chatId, texto)
                .filter(id => id !== 'servico_confirmar');

            if (ids.includes('cancelar_agendamento')) return processarEscolha(chatId, 'cancelar_agendamento', contato);
            if (ids.includes('cancelar')) return processarEscolha(chatId, 'cancelar', contato);
            if (ids.length > 0) return processarServicosSelecionados(chatId, ids, contato);

            const escolhaUnica = resolverEscolhaPorTexto(chatId, texto);
            if (escolhaUnica === 'cancelar') return processarEscolha(chatId, 'cancelar', contato);
        }

        // Demais estados: tenta casar o texto com a enquete ativa
        if (estado) {
            const escolha = resolverEscolhaPorTexto(chatId, texto);
            if (escolha) return processarEscolha(chatId, escolha, contato);

            const registro = ultimaEnquetePorChat[chatId];
            if (registro) {
                const menu = registro.opcoes.map((o, i) => `*[ ${i + 1} ]* - ${o.label}`).join('\n');
                return msg.reply(`Não entendi 🤔\n\nToque em uma das opções da enquete acima, ou digite o número:\n\n${menu}`);
            }
        }

        // Sem estado: inicia o atendimento
        return enviarMenuServicos(chatId, nomeCliente);
    } catch (err) {
        log('Erro no handler de mensagem:', err.message);
    }
});

async function cancelarAgendamentoDoCliente(chatId, contato) {
    const responder = t => client.sendMessage(chatId, t);

    // Procura por qualquer identificador conhecido do cliente (telefone ou LID)
    const identificadores = identificadoresDoContato(chatId, contato);
    const condicoes = [{ chatId: chatId }];
    for (const ident of identificadores) condicoes.push({ whatsapp: ident });

    const reservas = await prisma.horario.findMany({
        where: { status: 'ocupado', OR: condicoes }
    });

    // Só cancela agendamentos futuros
    const agora = new Date();
    const futuras = reservas.filter(r => stringParaData(r.data, r.hora) > agora);

    log('Cancelamento pedido por', chatId,
        '| identificadores:', identificadores.join(' | '),
        '| reservas encontradas:', reservas.length,
        '| futuras:', futuras.length);

    if (futuras.length === 0) {
        encerrarAtendimento(chatId);
        const aviso = reservas.length > 0
            ? 'Você não tem agendamento futuro para cancelar — o horário que encontramos no seu número já passou.'
            : 'Não encontramos nenhum agendamento ativo no seu número.';
        return responder(`${aviso}\n\nSe quiser marcar um novo horário, envie um "Oi".`);
    }

    const grupos = [...new Set(futuras.map(r => r.grupoId).filter(Boolean))];
    const primeira = futuras.sort((a, b) => stringParaData(a.data, a.hora) - stringParaData(b.data, b.hora))[0];

    await prisma.horario.updateMany({
        where: grupos.length ? { grupoId: { in: grupos } } : { id: { in: futuras.map(r => r.id) } },
        data: {
            status: 'disponivel',
            cliente: null, servico: null, whatsapp: null,
            chatId: null, grupoId: null,
            lembreteEnviado: false, feedbackEnviado: false
        }
    });

    await avisarFila(primeira.data);
    await notificarBarbeiro(`❌ *CANCELAMENTO*\n\nO cliente ${primeira.cliente || identificadores[0]} cancelou o horário de *${primeira.data}* às *${primeira.hora}* (${primeira.servico}).`);

    log('Cancelado:', primeira.cliente, primeira.data, primeira.hora);
    encerrarAtendimento(chatId);
    return responder(
        `✅ *Agendamento cancelado!*\n\n` +
        `📅 ${primeira.data} às ${primeira.hora}\n` +
        `✂️ ${primeira.servico}\n\n` +
        `O horário foi liberado. Se quiser remarcar, envie um "Oi".`);
}

// ==========================================
// TRATAMENTO DE ERROS E DESLIGAMENTO
// ==========================================
const errosBenignos = ['Protocol error', 'Target closed', 'Session closed', 'Execution context was destroyed'];

process.on('unhandledRejection', (reason) => {
    log('Promise rejeitada sem tratamento:', reason?.message || String(reason));
});

process.on('uncaughtException', (err) => {
    const texto = err?.message || String(err);
    log('EXCEÇÃO NÃO TRATADA:', texto);

    if (errosBenignos.some(e => texto.includes(e))) {
        log('Erro conhecido do navegador. Mantendo o processo e deixando o watchdog agir.');
        return;
    }

    log('Erro grave. Encerrando para o PM2 reiniciar limpo.');
    setTimeout(() => process.exit(1), 1000);
});

async function desligar(sinal) {
    log(`Recebido ${sinal}. Encerrando com segurança...`);
    try { await client.destroy(); } catch {}
    try { await prisma.$disconnect(); } catch {}
    process.exit(0);
}

process.on('SIGINT', () => desligar('SIGINT'));
process.on('SIGTERM', () => desligar('SIGTERM'));

// ==========================================
// INICIALIZAÇÃO
// ==========================================
app.listen(PORTA_API, '0.0.0.0', () => {
    log(`API ativa na porta ${PORTA_API}`);
    client.initialize().catch(err => {
        log('Falha ao inicializar o WhatsApp:', err.message);
        process.exit(1);
    });
});
