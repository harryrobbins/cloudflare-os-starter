// Create a datastore (organisation data administrators only). The creator does not become a
// member: the chosen owner holds the dataset.

import { CreateDatastoreInputSchema, type DatastoreSummary, type DiscoveryPolicy } from '@records/contracts'
import { useState } from 'react'
import type { DirectoryPerson, Whoami } from '../api'
import { useDataApi } from '../bridge'
import { validate } from '../errors'
import { PrincipalPicker } from './PrincipalPicker'
import { Btn, ErrorNotice, Modal, ModalFooter, TextAreaField, TextField, useAction } from './ui'

export function CreateDatastoreDialog({
  open,
  me,
  onClose,
  onCreated,
}: {
  open: boolean
  me: Whoami
  onClose: () => void
  onCreated: (created: DatastoreSummary, owner: DirectoryPerson) => void
}) {
  const api = useDataApi()
  const action = useAction()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [owner, setOwner] = useState<DirectoryPerson | null>(null)
  const [ownerTeam, setOwnerTeam] = useState('')
  const [discovery, setDiscovery] = useState<DiscoveryPolicy>('members')
  const [projectKey, setProjectKey] = useState('')
  const [projectName, setProjectName] = useState('')

  const reset = () => {
    setName('')
    setDescription('')
    setOwner(null)
    setOwnerTeam('')
    setDiscovery('members')
    setProjectKey('')
    setProjectName('')
    action.setError(null)
  }
  const close = () => {
    reset()
    onClose()
  }

  const submit = async () => {
    const wantsProject = projectKey.trim() !== '' || projectName.trim() !== ''
    const input = {
      name,
      description,
      moduleId: 'projects' as const,
      ownerPrincipalId: owner?.id ?? '',
      ownerTeam: ownerTeam.trim() || null,
      discovery,
      ...(wantsProject ? { initialProject: { key: projectKey.trim().toUpperCase(), name: projectName } } : {}),
    }
    const checked = validate(CreateDatastoreInputSchema, input)
    if (!checked.ok) {
      action.setError(
        owner
          ? checked.error
          : { ...checked.error, issues: [{ path: 'owner', message: 'Choose an owner' }, ...checked.error.issues.filter((i) => i.path !== 'ownerPrincipalId')] },
      )
      return
    }
    const created = await action.run(() => api.createDatastore(input))
    if (created && owner) {
      onCreated(created, owner)
      reset()
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      busy={action.busy}
      title="New datastore"
      description="A Projects datastore owned by the person you choose. Creating it does not give you access to its records."
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
        <TextAreaField label="Description" optional value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
        <div>
          <PrincipalPicker label="Owner" value={owner} onChange={setOwner} disabled={action.busy} />
          {!owner ? (
            <Btn
              tone="ghost"
              className="mt-1"
              onClick={() => setOwner({ ...me.principal, email: me.email })}
            >
              Make me the owner
            </Btn>
          ) : null}
        </div>
        <TextField label="Owner team" optional value={ownerTeam} onChange={(e) => setOwnerTeam(e.target.value)} maxLength={120} />
        <fieldset>
          <legend className="mb-1.5 text-[12px] font-medium text-kumo-subtle">Who can discover it</legend>
          <div className="space-y-1.5 text-[13px]">
            <label className="flex items-start gap-2">
              <input type="radio" name="discovery" value="members" checked={discovery === 'members'} onChange={() => setDiscovery('members')} className="mt-0.5" />
              <span>
                Members only
                <span className="block text-[12px] text-kumo-subtle">Only people with access can see it exists.</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="discovery"
                value="organisation"
                checked={discovery === 'organisation'}
                onChange={() => setDiscovery('organisation')}
                className="mt-0.5"
              />
              <span>
                Whole organisation
                <span className="block text-[12px] text-kumo-subtle">
                  Anyone can find its name and request access. This never grants access to records.
                </span>
              </span>
            </label>
          </div>
        </fieldset>
        <fieldset className="grid grid-cols-[8rem_1fr] gap-3">
          <legend className="mb-1.5 text-[12px] font-medium text-kumo-subtle">First project (optional)</legend>
          <TextField
            label="Key"
            value={projectKey}
            onChange={(e) => setProjectKey(e.target.value.toUpperCase())}
            placeholder="ENG"
            maxLength={10}
            hint="2–10 capitals/digits"
          />
          <TextField label="Project name" value={projectName} onChange={(e) => setProjectName(e.target.value)} maxLength={120} />
        </fieldset>
        <ErrorNotice error={action.error} />
        <ModalFooter>
          <Btn onClick={close} disabled={action.busy}>
            Cancel
          </Btn>
          <Btn tone="primary" type="submit" loading={action.busy}>
            Create datastore
          </Btn>
        </ModalFooter>
      </form>
    </Modal>
  )
}
