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
const START_BLOCKS_BACK = 100;

const DISTRIBUTOR_ABI = [
    "event Withdrawal(address indexed shelter, uint256 amount)"
];

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let provider = null;
let lastCheckedBlock = null;

// ========== ФУНКЦИИ ==========
async function findWorkingRpc() {
    for (const rpcUrl of RPC_URLS) {
        try {
            const testProvider = new ethers.JsonRpcProvider(rpcUrl);
            await testProvider.getBlockNumber();
            console.log(`✅ RPC: ${rpcUrl.split('/')[2]}`);
            return testProvider;
        } catch (error) {
            console.log(`❌ RPC не работает: ${rpcUrl.split('/')[2]}`);
        }
    }
    throw new Error('Нет рабочих RPC');
}

async function fetchWithdrawalEvents(fromBlock, toBlock) {
    if (!provider) return [];
    try {
        const contract = new ethers.Contract(DISTRIBUTOR_ADDRESS, DISTRIBUTOR_ABI, provider);
        const events = await contract.queryFilter('Withdrawal', fromBlock, toBlock);
        return events;
    } catch (error) {
        console.error(`Ошибка поиска: ${error.message}`);
        return [];
    }
}

async function processWithdrawalEvent(event) {
    const shelterAddress = event.args.shelter.toLowerCase();
    const amountRaw = event.args.amount;
    const amount = parseFloat(ethers.formatUnits(amountRaw, USDC_DECIMALS));
    const transactionHash = event.transactionHash;
    const blockNumber = event.blockNumber;
    
    console.log(`\n🔔 НОВОЕ РАСПРЕДЕЛЕНИЕ:`);
    console.log(`   Приют: ${shelterAddress}`);
    console.log(`   Сумма: ${amount} USDT`);
    console.log(`   Транзакция: ${transactionHash.slice(0, 20)}...`);
    
    try {
        const { data: shelter, error: shelterError } = await supabase
            .from('shelters')
            .select('id, name')
            .eq('wallet_address', shelterAddress)
            .single();
        
        if (shelterError || !shelter) {
            console.error(`   ❌ Приют не найден: ${shelterAddress}`);
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
            console.log(`   ✅ ЗАПИСАНО! Сумма: ${amount} USDT`);
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
            lastCheckedBlock = currentBlock - START_BLOCKS_BACK;
            console.log(`\n🚀 Старт с блока ${lastCheckedBlock}`);
        }
        
        const currentBlock = await provider.getBlockNumber();
        
        if (currentBlock > lastCheckedBlock) {
            const events = await fetchWithdrawalEvents(lastCheckedBlock + 1, currentBlock);
            
            for (const event of events) {
                await processWithdrawalEvent(event);
            }
            
            lastCheckedBlock = currentBlock;
            if (events.length > 0) {
                console.log(`✅ Обработано ${events.length} событий, следующий блок: ${currentBlock + 1}`);
            }
        }
        
    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        provider = null;
    }
}

// ========== ЗАПУСК ==========
console.log('🚀 Запуск слушателя...');
console.log(`   Контракт: ${DISTRIBUTOR_ADDRESS}`);
console.log(`   Интервал: ${POLLING_INTERVAL / 1000} сек\n`);

mainLoop();
setInterval(mainLoop, POLLING_INTERVAL);

process.on('SIGINT', () => {
    console.log('\n🛑 Остановка...');
    process.exit(0);
});
