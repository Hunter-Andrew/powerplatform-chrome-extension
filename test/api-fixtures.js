// Canned Web API responses for the mock form (test/run.js routes /api/data/ requests here).
const lbl = (t) => ({ UserLocalizedLabel: { Label: t } });
const FORMXML = `<form><formLibraries><Library name="new_/scripts/account.js" libraryUniqueId="{11111111-0000-0000-0000-000000000001}"/></formLibraries>
<events>
  <event name="onload" application="false" active="false"><Handlers>
    <Handler functionName="Contoso.Account.onLoad" libraryName="new_/scripts/account.js" handlerUniqueId="{22222222-0000-0000-0000-000000000001}" enabled="true" parameters="" passExecutionContext="true"/>
  </Handlers></event>
  <event name="onchange" application="false" active="false" attribute="telephone1"><Handlers>
    <Handler functionName="Contoso.Account.onPhoneChange" libraryName="new_/scripts/account.js" handlerUniqueId="{22222222-0000-0000-0000-000000000002}" enabled="true" parameters="" passExecutionContext="true"/>
  </Handlers><InternalHandlers><Handler functionName="Mscrm.Internal" libraryName="x"/></InternalHandlers></event>
</events>
<tabs><tab name="SUMMARY_TAB"><events><event name="TabStateChange"><Handlers>
  <Handler functionName="Contoso.Account.onTab" libraryName="new_/scripts/account.js" enabled="false" passExecutionContext="false"/>
</Handlers></event></events></tab></tabs></form>`;

const RULE_XAML = `<Activity><mxswa:GetEntityProperty Attribute="revenue" Entity="[x]" EntityName="account" />
<mcwb:SetFieldRequiredLevel ControlId="telephone1" ControlType="standard" RequiredLevel="Required" />
<mcwb:SetVisibility ControlId="header_ownerid" IsVisible="False" /></Activity>`;

const CALC_XAML = `<Activity><mxswa:GetEntityProperty Attribute="revenue" Entity="[x]" EntityName="account" /><mxswa:SetEntityProperty Attribute="new_revenuex2" EntityName="account"/></Activity>`;

module.exports = function fixture(url) {
  const u = decodeURIComponent(url);
  if (/systemforms\(f0f0-0000-0000-0000-000000000001\)/.test(u)) return { name: 'Account Main', formxml: FORMXML };
  if (/workflows\?/.test(u) && /category eq 2/.test(u)) {
    return { value: [{ workflowid: 'dddd0001-0000-0000-0000-000000000001', name: 'Require phone for big accounts', statecode: 1,
      'statecode@OData.Community.Display.V1.FormattedValue': 'Activated', _processtriggerformid_value: null, xaml: RULE_XAML, description: '' }] };
  }
  if (/workflows\(bbbb0001/.test(u)) return { uniquename: 'new_accountsalesprocess', name: 'Account Sales Process' };
  if (/new_accountsalesprocesss\(cccc0001/.test(u)) {
    return { traversedpath: 'aaaa0001-0000-0000-0000-000000000001', activestagestartedon: '2026-10-30T10:00:00Z' };
  }
  if (/Attributes\(LogicalName='new_revenuex2'\)/.test(u)) return { LogicalName: 'new_revenuex2', FormulaDefinition: CALC_XAML };
  if (/Attributes\(LogicalName='new_fx'\)/.test(u)) return { LogicalName: 'new_fx', FormulaDefinition: 'Text(telephone1) & "!"' };
  if (/Attributes\?\$select=LogicalName,SourceType/.test(u)) {
    return { value: [
      { LogicalName: 'name', SourceType: 0, AttributeType: 'String', DisplayName: lbl('Account Name') },
      { LogicalName: 'telephone1', SourceType: 0, AttributeType: 'String', DisplayName: lbl('Phone') },
      { LogicalName: 'revenue', SourceType: 0, AttributeType: 'Money', DisplayName: lbl('Revenue') },
      { LogicalName: 'new_revenuex2', SourceType: 1, AttributeType: 'Money', DisplayName: lbl('Revenue x2') },
      { LogicalName: 'new_fx', SourceType: 3, AttributeType: 'String', DisplayName: lbl('Phone shout') },
    ] };
  }
  if (/PicklistAttributeMetadata/.test(u) && !/MultiSelect/.test(u)) {
    return { value: [{ LogicalName: 'industrycode', DisplayName: lbl('Industry'), OptionSet: { Name: 'industrycode', IsGlobal: false,
      Options: [1, 3, 7].map((v, i) => ({ Value: v, Label: lbl(['Accounting', 'Consulting', 'Retail'][i]) })) } },
    { LogicalName: 'customertypecode', DisplayName: lbl('Relationship Type'), OptionSet: { Name: 'customertypecode', IsGlobal: false,
      Options: [{ Value: 1, Label: lbl('Competitor') }] } }] };
  }
  if (/BooleanAttributeMetadata/.test(u)) {
    return { value: [{ LogicalName: 'donotemail', DisplayName: lbl('Do not allow Emails'), OptionSet: { Name: 'account_donotemail',
      FalseOption: { Value: 0, Label: lbl('Allow') }, TrueOption: { Value: 1, Label: lbl('Do Not Allow') } } }] };
  }
  if (/AttributeMetadata/.test(u)) return { value: [] };
  return null;
};
