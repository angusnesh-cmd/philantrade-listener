import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

// ========== КОНФИГУРАЦИЯ ==========
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DISTRIBUTOR_ADDRESS = '0x108448D4cbAAAB82778775E77337D90eC6671D7f';

const RPC_URLS = [
    "https://rpc-amoy.polygon.technology/",
    "https://polygon-amoy.g.alchemy.com/v2/demo",
    "https://rpc.ankr.com/polygon_amoy",
    "https://polygon-amoy-bor-rpc.publicnode.com"
];

const POLLING_INTERVAL = 15000; // 15 секунд
const USDC_DECIMALS = 6;
const START_BLOCKS_BACK = 100; // 🎯 ВСЕГО 100 блоков назад (вместо 10000)

const DISTRIBUTOR_ABI = [
    "event Withdrawal(address indexed shelter, uint256 amount)"
];

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let provider = null;
let lastCheckedBlock = null;

async function findWorkingRpc() {
    for (const rpcUrl of RPC_URLS) {
        try {
            console.log(`Пробуем RPC: ${rpcUrl}`);
            const testProvider = new ethers.JsonRpcProvider(rpcUrl);
            await testProvider.getBlockNumber();
            console.log(`✅ RPC работает: ${rpcUrl}`);
            return testProvider;
        } catch (error) {
            console.log(`❌ RPC не работает: ${rpcUrl}`);
        }
    }
    throw new Error('Нет рабочих RPC');
}

async function fetchWithdrawalEvents(fromBlock, toBlock) {
    if (!provider) return [];
    
    try {
        const contract = new ethers.Contract(DISTRIBUTOR_ADDRESS, DISTRIBUTOR_ABI, provider);
        
        if (fromBlock > toBlock) return [];
        
        console.log(`   Поиск событий: блоки ${fromBlock} → ${toBlock} (${toBlock - fromBlock + 1} блоков)`);
        
        const events = await contract.queryFilter('Withdrawal', fromBlock, toBlock);
        
        if (events.length > 0) {
            console.log(`   🎯 Найдено ${events.length} событий!`);
        }
        
        return events;
    } catch (error) {
        console.error(`   Ошибка поиска: ${error.message}`);
        return [];
    }
}

async function processWithdrawalEvent(event) {
    const shelterAddress = event.args.shelter.toLowerCase(); 
    const amountRaw = event.args.amount;
    const amount = parseFloat(ethers.formatUnits(amountRaw, USDC_DECIMALS));
    const transactionHash = event.transactionHash;
    
    console.log(`\n🔔 НОВОЕ РАСПРЕДЕЛЕНИЕ:`);
    console.log(`   Приют: ${shelterAddress}`);
    console.log(`   Сумма: ${amount} USDT`);
    
    // Ищем по нижнему регистру
    const { data: shelter, error } = await supabase
        .from('shelters')
        .select('id, name')
        .eq('wallet_address', shelterAddress) 
        .single();
    
}
        
        if (shelterError || !shelter) {
            console.error(`   ❌ Приют не найден в БД`);
            return;
        }
        
        console.log(`   ✅ Приют: ${shelter.name}`);
        
        const { data: existing } = await supabase
            .from('distributions')
            .select('id')
            .eq('transaction_hash', transactionHash)
            .maybeSingle();
        
        if (existing) {
            console.log(`   ⏭️ Уже обработано`);
            return;
        }
        
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
            console.error(`   ❌ Ошибка вставки: ${insertError.message}`);
        } else {
            console.log(`   ✅ ЗАПИСАНО В SUPABASE!`);
        }
        
    } catch (error) {
        console.error(`   ❌ Ошибка: ${error.message}`);
    }
}

async function mainLoop() {
    try {
        if (!provider) {
            provider = await findWorkingRpc();
            const currentBlock = await provider.getBlockNumber();
            // Начинаем только со 100 блоков назад (не 10000!)
            lastCheckedBlock = currentBlock - START_BLOCKS_BACK;
            console.log(`\n🚀 Старт с блока ${lastCheckedBlock} (текущий: ${currentBlock})`);
            console.log(`   (проверяем последние ${START_BLOCKS_BACK} блоков на пропущенные события)\n`);
        }
        
        const currentBlock = await provider.getBlockNumber();
        
        if (currentBlock > lastCheckedBlock) {
            const fromBlock = lastCheckedBlock + 1;
            const toBlock = currentBlock;
            
            console.log(`\n📡 Проверка новых блоков: ${fromBlock} → ${toBlock} (${toBlock - fromBlock + 1} блоков)`);
            
            const events = await fetchWithdrawalEvents(fromBlock, toBlock);
            
            for (const event of events) {
                await processWithdrawalEvent(event);
            }
            
            lastCheckedBlock = currentBlock;
            console.log(`   ✅ Готово, следующий блок: ${currentBlock + 1}`);
        } else {
            console.log(`⏳ Новых блоков нет (блок ${currentBlock})`);
        }
        
    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        provider = null;
    }
}

// ========== ЗАПУСК ==========
console.log('🚀 Запуск polling слушателя...');
console.log(`   Контракт: ${DISTRIBUTOR_ADDRESS}`);
console.log(`   Интервал: ${POLLING_INTERVAL / 1000} сек`);
console.log(`   Глубина при старте: ${START_BLOCKS_BACK} блоков\n`);

mainLoop();
setInterval(mainLoop, POLLING_INTERVAL);

process.on('SIGINT', () => {
    console.log('\n🛑 Остановка...');
    process.exit(0);
});
