import { JsonRpcProvider, WebSocketProvider } from '@ethersproject/providers'
import { Contract } from '@ethersproject/contracts'
import { Wallet } from '@ethersproject/wallet'
import { BigNumber } from '@ethersproject/bignumber'
import MASTER_ABI from '../abis/master.json'
import MULTICALL_ABI from '../abis/multicall.json'

enum ChainId {
  RINKEBY = 4,
  GOERLI = 5,
}

interface Job {
  id: BigNumber
}

interface WorkableJob {
  id: BigNumber
  bytes: string
}

const [, , privateKey, websocketEndpoint, jsonRpcEndpoint] = process.argv
if (!privateKey || !websocketEndpoint || !jsonRpcEndpoint) throw new Error('invalid parameters')

const MASTER_ADDRESS: { [chainId in ChainId]: string } = {
  [ChainId.RINKEBY]: '0xb1d53370ef46b0A8fF4071b9e294C60b479D25A0',
  [ChainId.GOERLI]: '0x95Bf186929194099899139Ff79998cC147290F28',
}

const MULTICALL_ADDRESS: { [chainId in ChainId]: string } = {
  [ChainId.RINKEBY]: '0x798d8ced4dff8f054a5153762187e84751a73344',
  [ChainId.GOERLI]: '0x44445F80e99C45b3ca8a6c208a993B31F342b01e',
}

;(async () => {
  const websocketProvider = new WebSocketProvider(websocketEndpoint)
  const jsonRpcProvider = new JsonRpcProvider(jsonRpcEndpoint)

  const wallet = new Wallet(privateKey, jsonRpcProvider)

  const { chainId } = await jsonRpcProvider.getNetwork()

  const masterAddress = MASTER_ADDRESS[chainId as ChainId]
  const multicallAddress = MULTICALL_ADDRESS[chainId as ChainId]
  if (!masterAddress || !multicallAddress) throw new Error(`invalid chain id ${chainId}`)

  const master = new Contract(masterAddress, MASTER_ABI, wallet)
  const multicall = new Contract(multicallAddress, MULTICALL_ABI, jsonRpcProvider)

  const workingOnJobs: { [id: number]: boolean } = {}
  websocketProvider.on('block', async (number) => {
    const jobsAmount = await master.jobsAmount()
    const jobs: Job[] = await master.jobsSlice(0, jobsAmount)

    const [, results] = await multicall.aggregateWithPermissiveness(
      jobs.map((job) => [
        masterAddress,
        master.interface.encodeFunctionData(master.interface.getFunction('workable(address,uint256)'), [
          wallet.address,
          job.id,
        ]),
      ])
    )

    const workableJobs: WorkableJob[] = []
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      const job = jobs[i]
      if (!result.success || workingOnJobs[job.id.toNumber()]) continue
      const [workable, bytes] = master.interface.decodeFunctionResult(
        master.interface.getFunction('workable(address,uint256)'),
        result.data
      )
      if (!workable) continue
      workableJobs.push({ id: job.id, bytes })
    }

    console.log(`Workable jobs at block ${number}: ${workableJobs.length}`)

    for (const { id, bytes } of workableJobs) {
      workingOnJobs[id.toNumber()] = true
      const transaction = await master.work(id, bytes)
      transaction.wait().finally(() => {
        console.log(`Finished working on job with id ${id.toNumber()}`)
        workingOnJobs[id.toNumber()] = false
      })
      console.log(`Started working on job with id ${id.toNumber()}`)
    }
  })
})()
