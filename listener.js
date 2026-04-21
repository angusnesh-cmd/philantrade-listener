import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

// ========== КОНФИГУРАЦИЯ ==========
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// МАССИВ ДИСТРИБЬЮТОРОВ (добавляй новых сюда)
const DISTRIBUTORS = [
    { address: "0x108448D4cbAAAB82778775E77337D90eC6671D7f", name: "Bitcoinholdrcompany" },
    // { address: "0x7062bB18B77f798ACb202c4f07A7E23Ddb702107", name: "Кошачье счастье" },
];

const RPC_URLS = [
    "https://rpc-amoy.polygon.technology/",
    "https://polygon-amoy.g.alchemy.com/v2/demo",
    "https://rpc.ankr.com/polygon_amoy",
    "https://polygon-amoy-bor-rpc.publicnode.com"
];

const POLLING_INTERVAL = 15000;
const USDC_DECIMALS = 6;
const START_BLOCKS_BACK = 100;

const DISTRIBUTOR_ABI = [
    "event Withdrawal(address indexed shelter, uint256 amount)"
];

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let provider = null;
let lastCheckedBlock = {};

// ========== ПОДКЛЮЧЕНИЕ К RPC ==========
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

// ========== ОБРАБОТКА СОБЫТИЯ ==========
async function processWithdrawalEvent(distributorAddress, shelterAddress, amountRaw, transactionHash, blockNumber) {
    const amount = parseFloat(ethers.formatUnits(amountRaw, USDC_DECIMALS));
    const shelterAddressLower = shelterAddress.toLowerCase();
    
    console.log(`\n🔔 РАСПРЕДЕЛЕНИЕ ОТ ${distributorAddress.slice(0, 10)}...`);
    console.log(`   Приют: ${shelterAddressLower}`);
    console.log(`   Сумма: ${amount} USDT`);
    console.log(`   Транзакция: ${transactionHash.slice(0, 20)}...`);
    
    // Вызываем SQL функцию add_distribution
    const { data, error } = await supabase.rpc('add_distribution', {
        p_distributor_address: distributorAddress,
        p_shelter_wallet: shelterAddressLower,
        p_amount: amount,
        p_transaction_hash: transactionHash,
        p_block_number: blockNumber
    });
    
    if (error) {
        console.error(`   ❌ Ошибка RPC: ${error.message}`);
    } else if (data?.success === false) {
        console.error(`   ❌ ${data.error}`);
    } else if (data?.success) {
        console.log(`   ✅ Успешно! Баланс: ${data.old_amount_due} → ${data.new_amount_due} USDT`);
    } else {
        console.log(`   📦 Ответ:`, data);
    }
}

// ========== ПОИСК СОБЫТИЙ ДЛЯ ВСЕХ ДИСТРИБЬЮТОРОВ ==========
async function checkAllDistributors() {
    if (!provider) return;
    
    try {
        const currentBlock = await provider.getBlockNumber();
        
        for (const distributor of DISTRIBUTORS) {
            const address = distributor.address;
            
            // Инициализируем lastCheckedBlock для этого дистрибьютора
            if (!lastCheckedBlock[address]) {
                lastCheckedBlock[address] = currentBlock - START_BLOCKS_BACK;
                console.log(`📡 ${distributor.name}: старт с блока ${lastCheckedBlock[address]}`);
            }
            
            if (currentBlock > lastCheckedBlock[address]) {
                try {
                    const contract = new ethers.Contract(address, DISTRIBUTOR_ABI, provider);
                    const events = await contract.queryFilter('Withdrawal', lastCheckedBlock[address] + 1, currentBlock);
                    
                    for (const event of events) {
                        await processWithdrawalEvent(
                            address,
                            event.args.shelter,
                            event.args.amount,
                            event.transactionHash,
                            event.blockNumber
                        );
                    }
                    
                    lastCheckedBlock[address] = currentBlock;
                    
                    if (events.length > 0) {
                        console.log(`   ✅ ${distributor.name}: обработано ${events.length} событий`);
                    }
                } catch (error) {
                    console.error(`❌ Ошибка для ${distributor.name}: ${error.message}`);
                }
            }
        }
    } catch (error) {
        console.error('❌ Ошибка в основном цикле:', error.message);
    }
}

// ========== ЗАПУСК ==========
async function main() {
    console.log('🚀 ЗАПУСК СЛУШАТЕЛЯ');
    console.log('===================');
    
    provider = await findWorkingRpc();
    
    console.log(`\n📡 Дистрибьюторы (${DISTRIBUTORS.length}):`);
    DISTRIBUTORS.forEach(d => console.log(`   - ${d.name}: ${d.address}`));
    
    console.log(`\n⏳ Интервал: ${POLLING_INTERVAL / 1000} сек`);
    console.log(`📦 Глубина при старте: ${START_BLOCKS_BACK} блоков\n`);
    
    // Первый запуск
    await checkAllDistributors();
    
    // Периодическая проверка
    setInterval(checkAllDistributors, POLLING_INTERVAL);
}

main().catch(console.error);

process.on('SIGINT', () => {
    console.log('\n🛑 Остановка слушателя...');
    process.exit(0);
});
