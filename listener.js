import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

// ========== КОНФИГУРАЦИЯ ==========
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DISTRIBUTOR_ADDRESS = '0x108448D4cbAAAB82778775E77337D90eC6671D7f';

// RPC URLs (как в твоём виджете)
const RPC_URLS = [
    "https://rpc-amoy.polygon.technology/",
    "https://polygon-amoy.g.alchemy.com/v2/demo",
    "https://rpc.ankr.com/polygon_amoy",
    "https://polygon-amoy-bor-rpc.publicnode.com"
];

const POLLING_INTERVAL = 15000; // 15 секунд
const USDC_DECIMALS = 6;

// ABI только для события Withdrawal
const DISTRIBUTOR_ABI = [
    "event Withdrawal(address indexed shelter, uint256 amount)"
];

// ========== ИНИЦИАЛИЗАЦИЯ ==========
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let provider = null;
let lastCheckedBlock = null;

// ========== ФУНКЦИЯ ПОДКЛЮЧЕНИЯ К RPC ==========
async function findWorkingRpc() {
    for (const rpcUrl of RPC_URLS) {
        try {
            console.log(`Пробуем RPC: ${rpcUrl}`);
            const testProvider = new ethers.JsonRpcProvider(rpcUrl);
            
            // Проверяем, работает ли RPC
            await testProvider.getBlockNumber();
            
            console.log(`✅ RPC работает: ${rpcUrl}`);
            return testProvider;
        } catch (error) {
            console.log(`❌ RPC не работает: ${rpcUrl}`);
        }
    }
    throw new Error('Нет рабочих RPC');
}

// ========== ПОИСК СОБЫТИЙ WITHDRAWAL ==========
async function fetchWithdrawalEvents(fromBlock, toBlock) {
    if (!provider) return [];
    
    try {
        const contract = new ethers.Contract(DISTRIBUTOR_ADDRESS, DISTRIBUTOR_ABI, provider);
        
        console.log(`Поиск событий Withdrawal с блока ${fromBlock} по ${toBlock}...`);
        
        const events = await contract.queryFilter('Withdrawal', fromBlock, toBlock);
        
        if (events.length > 0) {
            console.log(`Найдено ${events.length} событий Withdrawal!`);
        }
        
        return events;
    } catch (error) {
        console.error('Ошибка поиска событий:', error.message);
        return [];
    }
}

// ========== ОБРАБОТКА СОБЫТИЯ ==========
async function processWithdrawalEvent(event) {
    const shelterAddress = event.args.shelter;
    const amountRaw = event.args.amount;
    const amount = parseFloat(ethers.formatUnits(amountRaw, USDC_DECIMALS));
    const transactionHash = event.transactionHash;
    const blockNumber = event.blockNumber;
    
    console.log(`\n🔔 Найдено распределение:`);
    console.log(`   Приют: ${shelterAddress}`);
    console.log(`   Сумма: ${amount} USDT`);
    console.log(`   Транзакция: ${transactionHash}`);
    console.log(`   Блок: ${blockNumber}`);
    
    try {
        // Ищем приют в Supabase
        const { data: shelter, error: shelterError } = await supabase
            .from('shelters')
            .select('id, name')
            .eq('wallet_address', shelterAddress.toLowerCase())
            .single();
        
        if (shelterError || !shelter) {
            console.error(`❌ Приют не найден: ${shelterAddress}`);
            console.error(`   Ошибка: ${shelterError?.message}`);
            return;
        }
        
        console.log(`   ✅ Найден приют: ${shelter.name} (${shelter.id})`);
        
        // Проверяем, нет ли дубликата
        const { data: existing, error: checkError } = await supabase
            .from('distributions')
            .select('id')
            .eq('transaction_hash', transactionHash)
            .maybeSingle();
        
        if (existing) {
            console.log(`   ⏭️ Транзакция уже обработана, пропускаем`);
            return;
        }
        
        // Создаём запись
        const { error: insertError } = await supabase
            .from('distributions')
            .insert({
                distributor_address: DISTRIBUTOR_ADDRESS,
                shelter_id: shelter.id,
                amount: amount,
                transaction_hash: transactionHash,
                block_number: blockNumber,
                block_timestamp: new Date(),
                is_processed: false
            });
        
        if (insertError) {
            console.error(`❌ Ошибка вставки: ${insertError.message}`);
        } else {
            console.log(`   ✅ Запись создана в Supabase!`);
        }
        
    } catch (error) {
        console.error(`❌ Критическая ошибка: ${error.message}`);
    }
}

// ========== ОСНОВНОЙ ЦИКЛ ==========
async function mainLoop() {
    try {
        if (!provider) {
            provider = await findWorkingRpc();
            const currentBlock = await provider.getBlockNumber();
            // Начинаем с 1000 блоков назад, чтобы не пропустить старые события
            lastCheckedBlock = currentBlock - 1000;
            console.log(`Начальный блок: ${lastCheckedBlock}`);
        }
        
        const currentBlock = await provider.getBlockNumber();
        
        if (currentBlock > lastCheckedBlock) {
            console.log(`\n📡 Проверяем новые блоки (${lastCheckedBlock + 1} - ${currentBlock})...`);
            
            const events = await fetchWithdrawalEvents(lastCheckedBlock + 1, currentBlock);
            
            for (const event of events) {
                await processWithdrawalEvent(event);
            }
            
            lastCheckedBlock = currentBlock;
            console.log(`✅ Проверено до блока ${currentBlock}`);
        } else {
            console.log(`⏳ Новых блоков нет (текущий: ${currentBlock})`);
        }
        
    } catch (error) {
        console.error('❌ Ошибка в основном цикле:', error.message);
        // Сбрасываем провайдер, чтобы переподключиться при следующей итерации
        provider = null;
    }
}

// ========== ЗАПУСК ==========
console.log('🚀 Запуск polling слушателя...');
console.log(`   Контракт: ${DISTRIBUTOR_ADDRESS}`);
console.log(`   Интервал: ${POLLING_INTERVAL / 1000} сек`);

// Запускаем первый раз сразу
mainLoop();

// Затем запускаем по интервалу
setInterval(mainLoop, POLLING_INTERVAL);

// Обработка остановки
process.on('SIGINT', () => {
    console.log('\n🛑 Остановка слушателя...');
    process.exit(0);
});
