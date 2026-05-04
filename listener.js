import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const RPC_URLS = [
    "https://rpc-amoy.polygon.technology/",
    "https://polygon-amoy.g.alchemy.com/v2/demo",
    "https://rpc.ankr.com/polygon_amoy"
];

const POLLING_INTERVAL = 30000;        // Проверяем каждые 30 секунд
const DISTRIBUTORS_REFRESH_INTERVAL = 60000; // Обновляем список дистрибьюторов раз в минуту
const BLOCKS_PER_SCAN = 500;
const USDC_DECIMALS = 6;

const DISTRIBUTOR_ABI = [
    "event Withdrawal(address indexed shelter, uint256 amount)"
];

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let provider = null;
let lastCheckedBlock = 0;
let activeContractAddresses = new Set();  // Кэш активных контрактов
let lastDistributorsUpdate = 0;

// ============================================
// 1. ЗАГРУЗКА АКТИВНЫХ ДИСТРИБЬЮТОРОВ ИЗ БД
// ============================================
async function loadActiveDistributors() {
    const { data, error } = await supabase
        .from('distributors')
        .select('contract_address')
        .eq('is_active', true);
    
    if (error) {
        console.error('❌ Ошибка загрузки дистрибьюторов:', error);
        return;
    }
    
    const newSet = new Set(data.map(d => d.contract_address.toLowerCase()));
    
    // Проверяем, изменился ли список
    const oldSize = activeContractAddresses.size;
    const newSize = newSet.size;
    
    if (oldSize !== newSize) {
        console.log(`🔄 Обновлён список дистрибьюторов: ${oldSize} → ${newSize}`);
    }
    
    activeContractAddresses = newSet;
    console.log(`📋 Активных дистрибьюторов: ${activeContractAddresses.size}`);
}

// ============================================
// 2. ПОДКЛЮЧЕНИЕ К RPC
// ============================================
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

// ============================================
// 3. ПОЛУЧЕНИЕ ВСЕХ СОБЫТИЙ WITHDRAWAL
// ============================================
async function scanBlocks(fromBlock, toBlock) {
    if (fromBlock > toBlock) return [];
    if (activeContractAddresses.size === 0) return [];
    
    try {
        // Создаём фильтр для всех контрактов
        const filter = {
            address: null,
            topics: [ethers.id("Withdrawal(address,uint256)")]
        };
        
        const logs = await provider.getLogs({
            ...filter,
            fromBlock,
            toBlock
        });
        
        // Фильтруем логи, которые относятся к нашим контрактам
        const relevantLogs = logs.filter(log => 
            activeContractAddresses.has(log.address.toLowerCase())
        );
        
        if (relevantLogs.length > 0) {
            console.log(`📡 Блоки ${fromBlock}-${toBlock}: ${logs.length} всего, ${relevantLogs.length} наших`);
        }
        
        return relevantLogs;
        
    } catch (error) {
        console.error(`   Ошибка сканирования: ${error.message}`);
        return [];
    }
}

// ============================================
// 4. ОБРАБОТКА ОДНОГО ЛОГА
// ============================================
async function processLog(log) {
    try {
        const iface = new ethers.Interface(DISTRIBUTOR_ABI);
        const decoded = iface.parseLog(log);
        
        const distributorAddress = log.address;
        const shelterAddress = decoded.args.shelter;
        const amount = parseFloat(ethers.formatUnits(decoded.args.amount, USDC_DECIMALS));
        const transactionHash = log.transactionHash;
        const blockNumber = log.blockNumber;
        
        console.log(`\n🔔 ${distributorAddress.slice(0, 10)}... → ${shelterAddress.slice(0, 10)}...: ${amount} USDT`);
        
        // Вызываем SQL функцию add_distribution
        const { data, error } = await supabase.rpc('add_distribution', {
            p_distributor_address: distributorAddress,
            p_shelter_wallet: shelterAddress,
            p_amount: amount,
            p_transaction_hash: transactionHash,
            p_block_number: blockNumber
        });
        
        if (error) {
            console.error(`   ❌ Ошибка: ${error.message}`);
        } else if (data?.success === false) {
            console.error(`   ❌ ${data.error}`);
        } else if (data?.success) {
            console.log(`   ✅ Записано! Баланс приюта: ${data.old_amount_due} → ${data.new_amount_due} USDT`);
        }
        
        // Обновляем статистику дистрибьютора в таблице distributors
        await supabase.rpc('increment_distributor_stats', {
            p_contract_address: distributorAddress,
            p_amount: amount
        });
        
    } catch (error) {
        console.error(`   ❌ Ошибка парсинга: ${error.message}`);
    }
}

// ============================================
// 5. ОСНОВНОЙ ЦИКЛ СКАНЕРА
// ============================================
async function scanNewBlocks() {
    if (!provider) return;
    if (activeContractAddresses.size === 0) return;
    
    try {
        const currentBlock = await provider.getBlockNumber();
        
        if (lastCheckedBlock === 0) {
            // При первом запуске смотрим последние 1000 блоков
            lastCheckedBlock = currentBlock - 1000;
            console.log(`🚀 Стартовый блок: ${lastCheckedBlock}`);
        }
        
        if (currentBlock > lastCheckedBlock) {
            let fromBlock = lastCheckedBlock + 1;
            let toBlock = Math.min(currentBlock, fromBlock + BLOCKS_PER_SCAN - 1);
            let totalEvents = 0;
            
            while (fromBlock <= currentBlock) {
                const logs = await scanBlocks(fromBlock, toBlock);
                
                for (const log of logs) {
                    await processLog(log);
                    totalEvents++;
                }
                
                fromBlock = toBlock + 1;
                toBlock = Math.min(currentBlock, fromBlock + BLOCKS_PER_SCAN - 1);
            }
            
            lastCheckedBlock = currentBlock;
            
            if (totalEvents > 0) {
                console.log(`\n✅ Сканирование завершено до блока ${currentBlock}, обработано ${totalEvents} событий`);
            }
        }
        
    } catch (error) {
        console.error('❌ Ошибка:', error.message);
    }
}

// ============================================
// 6. ОБНОВЛЕНИЕ СПИСКА ДИСТРИБЬЮТОРОВ
// ============================================
async function refreshDistributors() {
    const now = Date.now();
    if (now - lastDistributorsUpdate > DISTRIBUTORS_REFRESH_INTERVAL) {
        await loadActiveDistributors();
        lastDistributorsUpdate = now;
    }
}

// ============================================
// 7. ЗАПУСК
// ============================================
async function main() {
    console.log('🚀 ЗАПУСК СЛУШАТЕЛЯ ДИСТРИБЬЮТОРОВ');
    console.log('=====================================');
    
    // Подключаемся к RPC
    provider = await findWorkingRpc();
    
    // Загружаем начальный список дистрибьюторов
    await loadActiveDistributors();
    lastDistributorsUpdate = Date.now();
    
    console.log(`\n📋 Активных дистрибьюторов: ${activeContractAddresses.size}`);
    if (activeContractAddresses.size > 0) {
        console.log('   Список:');
        for (const addr of activeContractAddresses) {
            console.log(`   - ${addr.slice(0, 10)}...${addr.slice(-8)}`);
        }
    }
    
    console.log(`\n⏳ Интервал проверки блоков: ${POLLING_INTERVAL / 1000} сек`);
    console.log(`🔄 Обновление списка дистрибьюторов: каждые ${DISTRIBUTORS_REFRESH_INTERVAL / 1000} сек`);
    console.log(`📦 Блоков за раз: ${BLOCKS_PER_SCAN}\n`);
    
    // Запускаем первый раз
    await scanNewBlocks();
    
    // Запускаем периодические задачи
    setInterval(async () => {
        await refreshDistributors();
    }, DISTRIBUTORS_REFRESH_INTERVAL);
    
    setInterval(async () => {
        await scanNewBlocks();
    }, POLLING_INTERVAL);
}

main().catch(console.error);

process.on('SIGINT', () => {
    console.log('\n🛑 Остановка слушателя...');
    process.exit(0);
});
