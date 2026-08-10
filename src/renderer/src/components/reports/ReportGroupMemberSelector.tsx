import React, { useEffect, useMemo, useState } from 'react'
import type { Contact } from '../../../../shared/types'

interface ReportGroupMember {
  wxid: string
  nickname: string
  groupNickname: string
  wechatNickname: string
  remark: string
  avatar: string
}

interface ReportGroupMemberSelectorProps {
  sourceContact: Contact | null
  disabled?: boolean
}

interface GroupMemberSnapshotState {
  contactId: string
  members: ReportGroupMember[]
  error: string
}

const displayMemberName = (member: ReportGroupMember): string =>
  member.groupNickname || member.wechatNickname || member.remark || member.nickname || member.wxid

export function ReportGroupMemberSelector({
  sourceContact,
  disabled
}: ReportGroupMemberSelectorProps): React.ReactElement | null {
  const [snapshotState, setSnapshotState] = useState<GroupMemberSnapshotState>({
    contactId: '',
    members: [],
    error: ''
  })
  const [selectedWxid, setSelectedWxid] = useState('')
  const [filter, setFilter] = useState('')
  const sourceContactId = sourceContact?.type === 'group' ? sourceContact.md5 : ''

  useEffect(() => {
    if (!sourceContactId) return
    let active = true
    void window.api
      .getGroupSnapshot(sourceContactId)
      .then((snapshot) => {
        if (!active) return
        setSnapshotState({
          contactId: sourceContactId,
          members: (snapshot?.members || []) as ReportGroupMember[],
          error: ''
        })
      })
      .catch((loadError) => {
        if (!active) return
        setSnapshotState({
          contactId: sourceContactId,
          members: [],
          error: loadError instanceof Error ? loadError.message : '群成员信息读取失败'
        })
      })
    return () => {
      active = false
    }
  }, [sourceContactId])

  const filteredMembers = useMemo(() => {
    const loadedMembers = snapshotState.contactId === sourceContactId ? snapshotState.members : []
    const keyword = filter.trim().toLowerCase()
    if (!keyword) return loadedMembers
    return loadedMembers.filter((member) =>
      [member.wxid, member.nickname, member.groupNickname, member.wechatNickname, member.remark]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(keyword))
    )
  }, [filter, snapshotState, sourceContactId])

  const loading = Boolean(sourceContactId) && snapshotState.contactId !== sourceContactId
  const error = snapshotState.contactId === sourceContactId ? snapshotState.error : ''

  const selectedMember =
    filteredMembers.find((member) => member.wxid === selectedWxid) || filteredMembers[0] || null

  if (!sourceContact || sourceContact.type !== 'group') return null

  return (
    <section className="report-section report-group-member-selector">
      <h3>群成员名称测试</h3>
      <p className="report-section-desc">
        选择一名成员对照群昵称、微信昵称和通讯录备注，确认日报使用的名称来源。
      </p>
      <div className="report-member-tools">
        <input
          type="search"
          value={filter}
          disabled={disabled || loading}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="搜索成员或 wxid"
          aria-label="搜索群成员"
        />
        <select
          value={selectedMember?.wxid || ''}
          disabled={disabled || loading || !filteredMembers.length}
          onChange={(event) => setSelectedWxid(event.target.value)}
          aria-label="选择群成员"
        >
          {filteredMembers.length ? (
            filteredMembers.map((member) => (
              <option key={member.wxid} value={member.wxid}>
                {displayMemberName(member)}
              </option>
            ))
          ) : (
            <option value="">暂无成员</option>
          )}
        </select>
      </div>
      {loading && <p className="report-member-status">正在读取群成员...</p>}
      {error && <p className="report-member-status error">{error}</p>}
      {selectedMember && (
        <dl className="report-member-details">
          <div>
            <dt>群昵称</dt>
            <dd>{selectedMember.groupNickname || '未设置'}</dd>
          </div>
          <div>
            <dt>微信昵称</dt>
            <dd>{selectedMember.wechatNickname || '未读取到'}</dd>
          </div>
          <div>
            <dt>通讯录备注</dt>
            <dd>{selectedMember.remark || '未设置'}</dd>
          </div>
          <div>
            <dt>wxid</dt>
            <dd className="report-member-wxid">{selectedMember.wxid}</dd>
          </div>
        </dl>
      )}
    </section>
  )
}
