/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CosmosClient, ItemDefinition, PartitionKeyDefinition, RequestOptions } from '@azure/cosmos';
import { Resource } from 'azure-arm-resource/lib/resource/models';
import * as vscode from 'vscode';
import { AzureTreeItem, DialogResponses, IActionContext, UserCancelledError } from 'vscode-azureextensionui';
import { getThemeAgnosticIconPath } from '../../constants';
import { IEditableTreeItem } from '../../DatabasesFileSystem';
import { ext } from '../../extensionVariables';
import { getDocumentTreeItemLabel } from '../../utils/vscodeUtils';
import { DocDBDocumentsTreeItem } from './DocDBDocumentsTreeItem';
import { IDocDBTreeRoot } from './IDocDBTreeRoot';

const hiddenFields: string[] = ['_rid', '_self', '_etag', '_attachments', '_ts'];

/**
 * Represents a Cosmos DB DocumentDB (SQL) document
 */
export class DocDBDocumentTreeItem extends AzureTreeItem<IDocDBTreeRoot> implements IEditableTreeItem {
    public static contextValue: string = "cosmosDBDocument";
    public readonly contextValue: string = DocDBDocumentTreeItem.contextValue;
    public readonly commandId: string = 'cosmosDB.openDocument';
    public readonly parent: DocDBDocumentsTreeItem;
    public readonly cTime: number = Date.now();
    public mTime: number = Date.now();

    private readonly _partitionKeyValue: string | undefined | PartitionKeyDefinition;
    private _label: string;
    private _document: ItemDefinition & Resource;

    constructor(parent: DocDBDocumentsTreeItem, document: ItemDefinition & Resource) {
        super(parent);
        this._document = document;
        this._partitionKeyValue = this.getPartitionKeyValue();
        this._label = getDocumentTreeItemLabel(this._document);
        ext.fileSystem.fireChangedEvent(this);
    }

    public get id(): string {
        return this.document._rid || `${this.document.id}:${this.getPartitionKeyValue()}`;
        // Every document has an _rid field, even though the type definitions call it optional. The second clause is fallback.
        // The toString implicit conversion handles undefined and {} as expected. toString satisfies the uniqueness criterion.
    }

    public get filePath(): string {
        return this.label + '-cosmos-document.json';
    }

    public async refreshImpl(): Promise<void> {
        this._label = getDocumentTreeItemLabel(this._document);
        ext.fileSystem.fireChangedEvent(this);
    }

    public get link(): string {
        return this.document._self;
    }

    get document(): ItemDefinition & Resource {
        return this._document;
    }

    get label(): string {
        return this._label;
    }

    public get iconPath(): string | vscode.Uri | { light: string | vscode.Uri; dark: string | vscode.Uri } {
        return getThemeAgnosticIconPath('Document.svg');
    }

    public async deleteTreeItemImpl(): Promise<void> {
        const message: string = `Are you sure you want to delete document '${this.label}'?`;
        const result = await vscode.window.showWarningMessage(message, { modal: true }, DialogResponses.deleteResponse, DialogResponses.cancel);
        if (result === DialogResponses.deleteResponse) {
            const client = this.root.getDocumentClient();
            await client.database(this.parent.parent.parent.id).container(this.parent.parent.id).item(this.id).delete({ this._partitionKeyValue });
        } else {
            throw new UserCancelledError();
        }
    }

    public async getFileContent(): Promise<string> {
        const clonedDoc: {} = { ...this.document };
        for (const field of hiddenFields) {
            delete clonedDoc[field];
        }
        return JSON.stringify(clonedDoc, null, 2);
    }

    public async writeFileContent(_context: IActionContext, content: string): Promise<void> {
        const newData = JSON.parse(content);
        for (const field of hiddenFields) {
            newData[field] = this.document[field];
        }

        const client: CosmosClient = this.root.getDocumentClient();
        if (["_etag"].some((element) => !newData[element])) {
            throw new Error(`The "_self" and "_etag" fields are required to update a document`);
        } else {
            const options: RequestOptions = { accessCondition: { type: 'IfMatch', condition: newData._etag } };
            this._document = await client.database(this.parent.parent.parent.id).container(this.parent.parent.id).item(this.id).replace(newData, options);
        }
    }

    private getPartitionKeyValue(): string | undefined | PartitionKeyDefinition {
        const partitionKey = this.parent.parent.partitionKey;
        if (!partitionKey) { //Fixed collections -> no partitionKeyValue
            return undefined;
        }
        const fields = partitionKey.paths[0].split('/');
        if (fields[0] === '') {
            fields.shift();
        }
        let value;
        for (const field of fields) {
            value = value ? value[field] : this.document[field];
            if (!value) { //Partition Key exists, but this document doesn't have a value
                return '';
            }
        }
        return value;
    }
}
