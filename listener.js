import { ethers } from 'ethers'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

// ============================================
// 1. ИНИЦИАЛИЗАЦИЯ
// ============================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const provider = new ethers.WebSocketProvider(process.env.POLYGON_RPC_URL)

// Минимальный ABI — только событие Withdrawal
const DISTRIBUTOR_ABI = [
  "event Withdrawal(address indexed shelter, uint256 amount)"
]

const contract = new ethers.Contract(
  process.env.DISTRIBUTOR_ADDRESS,
  DISTRIBUTOR_ABI,
  provider
)

// ============================================
// 2. ОСНОВНАЯ ЛОГИКА ОБРАБОТКИ СОБЫТИЯ
// ============================================
async function handleWithdrawal(shelterAddress, amount, event) {
  console.log(`\n🔔 Новое событие Withdrawal:`)
  console.log(`   Приют: ${shelterAddress}`)
  console.log(`   Сумма: ${ethers.formatUnits(amount, 6)} USDT`)
  console.log(`   Транзакция: ${event.transactionHash}`)
  console.log(`   Дистрибьютор: ${event.address}`)

  try {
    // 1. Находим приют в Supabase по wallet_address
    const { data: shelter, error: shelterError } = await supabase
      .from('shelters')
      .select('id, name')
      .eq('wallet_address', shelterAddress)
      .single()

    if (shelterError || !shelter) {
      console.error(`❌ Приют не найден в БД: ${shelterAddress}`)
      console.error(`   Ошибка: ${shelterError?.message}`)
      return
    }

    console.log(`   ✅ Найден приют: ${shelter.name} (${shelter.id})`)

    // 2. Проверяем, нет ли уже такой транзакции (дубль)
    const { data: existing, error: checkError } = await supabase
      .from('distributions')
      .select('id')
      .eq('transaction_hash', event.transactionHash)
      .maybeSingle()

    if (existing) {
      console.log(`   ⏭️ Транзакция уже обработана, пропускаем`)
      return
    }

    // 3. Создаем запись в таблице distributions
    const { data: distribution, error: insertError } = await supabase
      .from('distributions')
      .insert({
        distributor_address: event.address,
        shelter_id: shelter.id,
        amount: parseFloat(ethers.formatUnits(amount, 6)),
        transaction_hash: event.transactionHash,
        block_number: event.blockNumber,
        block_timestamp: new Date(),
        is_processed: false
      })
      .select()
      .single()

    if (insertError) {
      console.error(`❌ Ошибка при сохранении: ${insertError.message}`)
      return
    }

    console.log(`   💾 Запись создана: ${distribution.id}`)
    console.log(`   📊 Приют должен отчитаться на сумму ${ethers.formatUnits(amount, 6)} USDT`)

  } catch (error) {
    console.error(`❌ Критическая ошибка: ${error.message}`)
  }
}

// ============================================
// 3. ЗАПУСК СЛУШАТЕЛЯ
// ============================================
async function startListener() {
  console.log('🚀 Запуск слушателя блокчейна...')
  console.log(`   Дистрибьютор: ${process.env.DISTRIBUTOR_ADDRESS}`)
  console.log(`   RPC: ${process.env.POLYGON_RPC_URL}`)
  console.log(`   Supabase: ${process.env.SUPABASE_URL}`)

  // Подписываемся на событие Withdrawal
  contract.on('Withdrawal', (shelter, amount, event) => {
    handleWithdrawal(shelter, amount, event)
  })

  console.log('✅ Слушатель активен, ждём событий Withdrawal...\n')
}

// ============================================
// 4. ОБРАБОТКА ОСТАНОВКИ
// ============================================
process.on('SIGINT', async () => {
  console.log('\n🛑 Остановка слушателя...')
  contract.removeAllListeners()
  await provider.destroy()
  process.exit(0)
})

// Запускаем
startListener().catch(console.error)