// The capability this page receives. Type-only: the page never imports Worker code.

import type { DataManagementApi } from '../src/vendor/management.ts'
import type { Whoami } from '../src/domain/registry.ts'

export type { DataManagementApi, Whoami }

/**
 * What components call. In production this is the host's `ui` RpcStub; in tests an in-memory fake.
 * Both return promises of plain data.
 */
export type DataApi = DataManagementApi

export type DirectoryPerson = Awaited<ReturnType<DataManagementApi['searchPrincipals']>>[number]
