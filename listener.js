import { ethers } from 'ethers'
import { createClient } from '@supabase/supabase-js'

// Не используем dotenv — Railway сам передаёт переменные
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const rpcUrl = process.env.POLYGON_RPC_URL
const distributorAddress = process.env.DISTRIBUTOR_ADDRESS

console.log('=== ДИАГНОСТИКА ===')
console.log('SUPABASE_URL:', supabaseUrl ? '✅' : '❌')
console.log('SUPABASE_KEY:', supabaseKey ? '✅' : '❌')
console.log('RPC_URL:', rpcUrl ? '✅' : '❌')
console.log('DISTRIBUTOR_ADDRESS:', distributorAddress)
console.log('==================')

if (!supabaseUrl || !supabaseKey || !rpcUrl || !distributorAddress) {
  console.error('❌ Ошибка: не все переменные окружения заданы!')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)
const provider = new ethers.WebSocketProvider(rpcUrl)

const DISTRIBUTOR_ABI = [
  "event Withdrawal(address indexed shelter, uint256 amount)"
]

const contract = new ethers.Contract(distributorAddress, DISTRIBUTOR_ABI, provider)

async function handleWithdrawal(shelterAddress, amount, event) {
  console.log(`\n🔔 Withdrawal получен!`)
  console.log(`   shelter: ${shelterAddress}`)
  console.log(`   amount: ${ethers.formatUnits(amount, 6)} USDT`)
  console.log(`   txHash: ${event.transactionHash}`)

  // Приводим адрес к нижнему регистру для сравнения
  const normalizedAddress = shelterAddress.toLowerCase()
  console.log(`   normalized: ${normalizedAddress}`)

  const { data: shelter, error } = await supabase
    .from('shelters')
    .select('id, name, wallet_address')
    .eq('wallet_address', normalizedAddress)
    .maybeSingle()

  if (error) {
    console.error(`   ❌ Ошибка БД: ${error.message}`)
    return
  }

  if (!shelter) {
    console.error(`   ❌ Приют не найден для адреса: ${normalizedAddress}`)
    
    // Выведем все адреса из таблицы для отладки
    const { data: all } = await supabase.from('shelters').select('wallet_address')
    console.log(`   📋 Все адреса в БД:`, all?.map(s => s.wallet_address) || [])
    return
  }

  console.log(`   ✅ Найден приют: ${shelter.name}`)

  // Проверка на дубликат
  const { data: existing } = await supabase
    .from('distributions')
    .select('id')
    .eq('transaction_hash', event.transactionHash)
    .maybeSingle()

  if (existing) {
    console.log(`   ⏭️ Дубликат, пропускаем`)
    return
  }

  const { error: insertError } = await supabase
    .from('distributions')
    .insert({
      distributor_address: distributorAddress,
      shelter_id: shelter.id,
      amount: parseFloat(ethers.formatUnits(amount, 6)),
      transaction_hash: event.transactionHash,
      block_number: event.blockNumber,
      block_timestamp: new Date(),
      is_processed: false
    })

  if (insertError) {
    console.error(`   ❌ Ошибка вставки: ${insertError.message}`)
  } else {
    console.log(`   ✅ Запись создана!`)
  }
}

contract.on('Withdrawal', handleWithdrawal)

console.log('🚀 Слушатель запущен и ждёт событий Withdrawal...')
console.log(`   Адрес: ${distributorAddress}`)
